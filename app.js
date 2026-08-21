import * as MB from './vendor/mediabunny.mjs';

const {
	Input,
	BlobSource,
	ALL_FORMATS,
	Mp4OutputFormat,
	WebMOutputFormat,
	AppendOnlyStreamTarget,
	Output,
	Conversion,
	Quality,
	ConversionCanceledError,
} = MB;

/* ================================================================== */
/*  Settings                                                          */
/* ================================================================== */

const SETTINGS_KEY = 'web-transcoder-settings';
const defaultSettings = {
	videoOnly: true,     // default for new files; each file can override it
	bitrateMode: 'auto', // auto | always | copy
	format: 'mp4',       // mp4 | webm
};

let settings = {
	...defaultSettings,
	...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'),
};

const els = {
	videoOnly: document.getElementById('set-video-only'),
	bitrateMode: document.getElementById('set-bitrate-mode'),
	format: document.getElementById('set-format'),
	transcodeAll: document.getElementById('btn-transcode-all'),
	clear: document.getElementById('btn-clear'),
	dropzone: document.getElementById('dropzone'),
	fileInput: document.getElementById('file-input'),
	list: document.getElementById('file-list'),
	warning: document.getElementById('webcodecs-warning'),
};

function saveSettings() {
	settings.bitrateMode = els.bitrateMode.value;
	settings.format = els.format.value;
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	// Re-evaluate the decision for every file that has been analyzed.
	for (const entry of files.values()) {
		if (entry.tracks) {
			entry.decision = computeDecision(entry);
			updateCard(entry);
		}
	}
}

/**
 * The global “video only” toggle applies to all files at once, clearing
 * any per-file overrides. (When the checkbox is indeterminate, a click
 * checks it — the standard “set everything to on” behavior.)
 */
function applyGlobalVideoOnly() {
	settings.videoOnly = els.videoOnly.checked;
	localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	for (const entry of files.values()) {
		entry.videoOnlyOverride = null; // follow the global setting
		if (entry.video) entry.decision = computeDecision(entry);
		if (entry.tracks) updateCard(entry);
	}
	updateGlobalCheckbox();
}

function applySettingsToUi() {
	els.bitrateMode.value = settings.bitrateMode;
	els.format.value = settings.format;
	updateGlobalCheckbox();
}

els.videoOnly.addEventListener('change', applyGlobalVideoOnly);
els.bitrateMode.addEventListener('change', saveSettings);
els.format.addEventListener('change', saveSettings);

/* ================================================================== */
/*  Environment check                                                 */
/* ================================================================== */

const webcodecsOk =
	typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';

if (!webcodecsOk) {
	els.warning.textContent =
		'⚠ WebCodecs is unavailable in this context. Transcoding requires a secure context — ' +
		'serve this page from http://localhost (e.g. `./serve.sh`) and reload. Analysis still works.';
	els.warning.classList.remove('hidden');
}

/* ================================================================== */
/*  State                                                             */
/* ================================================================== */

let nextId = 1;
const files = new Map(); // id -> entry
const queue = [];        // ids waiting to be transcoded (FIFO, processed one at a time)
let activeId = null;     // id currently converting

/* ================================================================== */
/*  Formatting helpers                                                */
/* ================================================================== */

function el(tag, cls) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	return e;
}

function fmtBytes(n) {
	if (n == null || !isFinite(n)) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return (i === 0 ? String(Math.round(n)) : n.toFixed(n >= 100 ? 0 : 1)) + ' ' + units[i];
}

function fmtBitrate(bps) {
	if (bps == null) return '—';
	if (bps >= 1e6) {
		const mbps = bps / 1e6;
		return (mbps >= 100 ? Math.round(mbps) : mbps.toFixed(1).replace(/\.0$/, '')) + ' Mbps';
	}
	return Math.round(bps / 1e3) + ' kbps';
}

function fmtDuration(sec) {
	if (sec == null || !isFinite(sec)) return '—';
	const s = Math.round(sec);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	const mm = String(m).padStart(2, '0');
	const ss = String(r).padStart(2, '0');
	return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function fmtFps(x) {
	return String(Math.round(x * 10) / 10);
}

function outputName(name, ext) {
	const i = name.lastIndexOf('.');
	const base = i > 0 ? name.slice(0, i) : name;
	return `${base}.${ext}`;
}

/* ================================================================== */
/*  Bitrate heuristics                                                */
/* ================================================================== */

/**
 * Recommended video bitrate (bps) for a given resolution & frame rate.
 * Base values follow common streaming recommendations, tiered by the
 * shorter dimension (the “p” value) of the video:
 *   480p: 1.5 M · 540p: 2.5 M · 720p: 4.5 M · 1080p: 8 M ·
 *   1440p: 16 M · 2160p: 35 M · 4320p: 53 M
 * Scaled proportionally to the frame rate (clamped to 15–60 fps).
 */
function targetVideoBitrate(width, height, fps) {
	const f = Math.max(0.5, Math.min(2, (fps || 30) / 30));
	// The “p” designation always refers to the shorter dimension
	// (height for landscape, width for portrait).
	const shortEdge = Math.min(width, height);
	let base;
	if (shortEdge >= 4320) base = 53e6;
	else if (shortEdge >= 2160) base = 35e6;
	else if (shortEdge >= 1440) base = 16e6;
	else if (shortEdge >= 1080) base = 8e6;
	else if (shortEdge >= 720) base = 4.5e6;
	else if (shortEdge >= 540) base = 2.5e6;
	else base = 1.5e6;
	return Math.round(base * f);
}

/** A measured bitrate above 1.5× the recommended value counts as "overkill". */
const OVERKILL_FACTOR = 1.5;

/* ================================================================== */
/*  Per-file “video only” override                                     */
/* ================================================================== */

/**
 * Effective “video only” for a file: its per-file override if set,
 * otherwise the global default.
 */
function fileVideoOnly(entry) {
	return entry.videoOnlyOverride !== null
		? entry.videoOnlyOverride
		: settings.videoOnly;
}

function setFileVideoOnly(entry, value) {
	entry.videoOnlyOverride = value;
	if (entry.video) entry.decision = computeDecision(entry);
	updateCard(entry);
	updateGlobalCheckbox();
}

function resetFileVideoOnly(entry) {
	entry.videoOnlyOverride = null; // follow the global setting again
	if (entry.video) entry.decision = computeDecision(entry);
	updateCard(entry);
	updateGlobalCheckbox();
}

/**
 * Keep the global “video only” checkbox in sync with the files: checked
 * when every file is on, unchecked when every file is off, and the
 * standard indeterminate (dash) state while individual files are set
 * differently from each other.
 */
function updateGlobalCheckbox() {
	const all = [...files.values()];
	const onCount = all.filter(fileVideoOnly).length;
	els.videoOnly.indeterminate =
		all.length > 0 && onCount > 0 && onCount < all.length;
	els.videoOnly.checked =
		all.length === 0 ? settings.videoOnly : onCount === all.length;
}

/* ================================================================== */
/*  Pass-through (no conversion needed)                                */
/* ================================================================== */

const MP4_FAMILY_EXTS = ['mp4', 'm4v', 'mov'];

/** Is the source file's container in the same family as the selected output format? */
function sameContainerFamily(entry) {
	const i = entry.name.toLowerCase().lastIndexOf('.');
	const ext = i >= 0 ? entry.name.slice(i + 1) : '';
	return settings.format === 'webm'
		? ext === 'webm'
		: MP4_FAMILY_EXTS.includes(ext);
}

/**
 * A file can be kept as-is (no conversion at all) when:
 *  - the video stream doesn't need re-encoding (bitrate is reasonable, or
 *    re-encoding is disabled), AND
 *  - no stream has to be removed (video-only is off, or the file has no
 *    audio to remove), AND
 *  - the source container matches the selected output format (changing the
 *    container still requires a cheap remux).
 * Keeping the original file means zero re-encoding and zero quality loss.
 */
function passThroughAllowed(entry, decision) {
	if (decision && decision.reencode) return false;
	const hasAudio = entry.tracks?.some((t) => t.kind === 'audio') ?? false;
	if (fileVideoOnly(entry) && hasAudio) return false; // audio must be removed
	return sameContainerFamily(entry);
}

function shouldPassThrough(entry) {
	return passThroughAllowed(entry, entry.decision);
}

/**
 * Decide what to do with a file, based on current settings and the
 * measured video stream bitrate.
 */
function computeDecision(entry) {
	if (!entry.video) return null;
	const v = entry.video;
	const target = targetVideoBitrate(v.width, v.height, v.fps);
	const resLabel =
		`${v.width}×${v.height}` + (v.fps ? ` @ ${fmtFps(v.fps)} fps` : '');

	const d = {
		target,
		measured: v.bitrate,
		overkill: false,
		reencode: false,
		action: null, // reencode | passthrough | remux-audio-removed | remux
		note: '',
	};

	if (settings.bitrateMode === 'copy') {
		d.note = 'never re-encode is selected — the stream is copied when the format allows it';
	} else if (v.bitrate == null) {
		if (settings.bitrateMode === 'always') {
			d.reencode = true;
			d.note = `bitrate unknown — re-encoding to ~${fmtBitrate(target)}`;
		} else {
			d.note = 'video bitrate unknown — no re-encoding decision was made';
		}
	} else {
		d.overkill = v.bitrate > target * OVERKILL_FACTOR;

		if (settings.bitrateMode === 'always') {
			d.reencode = true;
			d.note =
				`source is ${fmtBitrate(v.bitrate)} — always-re-encode selected, ` +
				`encoding at ~${fmtBitrate(target)} (recommended for ${resLabel})`;
		} else if (d.overkill) {
			d.reencode = true;
			d.note =
				`source stream is ${fmtBitrate(v.bitrate)} — overkill for ${resLabel} ` +
				`(recommended ~${fmtBitrate(target)}) — re-encoding at ~${fmtBitrate(target)}`;
		} else {
			d.note =
				`source stream is ${fmtBitrate(v.bitrate)} — reasonable for ${resLabel} ` +
				`(recommended ~${fmtBitrate(target)}) — no re-encoding needed`;
		}
	}

	// what happens to the file itself
	const hasAudio = entry.tracks?.some((t) => t.kind === 'audio') ?? false;
	d.action = d.reencode
		? 'reencode'
		: passThroughAllowed(entry, d)
			? 'passthrough'
			: fileVideoOnly(entry) && hasAudio
				? 'remux-audio-removed'
				: 'remux';
	return d;
}

/* ================================================================== */
/*  File entries                                                      */
/* ================================================================== */

function makeEntry(file) {
	const entry = {
		id: nextId++,
		file,
		name: file.name,
		size: file.size,
		status: 'analyzing', // analyzing | ready | queued | converting | done | canceled | error
		duration: null,
		title: null,
		tracks: null, // analyzed stream metadata
		video: null,  // { width, height, fps, codec, bitrate, bitrateSource }
		decision: null,
		videoOnlyOverride: null, // null = follow the global setting
		progress: 0,
		bytesWritten: 0,
		output: null,  // { blob, size, ext }
		objectUrl: null,
		discarded: [],
		error: null,
		conversion: null,
		dom: null,
	};
	files.set(entry.id, entry);
	entry.dom = buildCard(entry);
	els.list.appendChild(entry.dom.root);
	updateCard(entry);
	analyze(entry);
	return entry;
}

function addFiles(fileList) {
	const arr =
		fileList instanceof File ? [fileList] : Array.from(fileList);
	for (const file of arr) makeEntry(file);
	refreshGlobalButtons();
	updateGlobalCheckbox();
}

/* ================================================================== */
/*  Analysis (metadata + bitrate)                                     */
/* ================================================================== */

async function analyze(entry) {
	try {
		const input = new Input({
			formats: ALL_FORMATS,
			source: new BlobSource(entry.file),
		});

		const trackObjs = await input.getTracks();
		const info = [];
		for (const track of trackObjs) {
			const t = {
				kind: track.type,
				number: track.number,
				codec: null,
				lang: 'und',
				name: null,
				bitrate: null,
				bitrateSource: null,
			};
			[t.codec, t.lang, t.name] = await Promise.all([
				track.getCodec(),
				track.getLanguageCode(),
				track.getName(),
			]);
			const [avg, peak] = await Promise.all([
				track.getAverageBitrate(),
				track.getBitrate(),
			]);
			t.bitrate = avg ?? peak;
			t.bitrateSource =
				avg != null ? 'average (file metadata)' : peak != null ? 'peak (file metadata)' : null;
			if (t.bitrate == null) {
				// Not exposed by file metadata — sample the first ~50 packets.
				try {
					const stats = await track.computePacketStats(50);
					t.bitrate = stats.averageBitrate;
					t.bitrateSource = 'estimated from ~50 packets';
				} catch {
					/* leave as null */
				}
			}

			if (track.isVideoTrack()) {
				t.width = await track.getDisplayWidth();
				t.height = await track.getDisplayHeight();
				t.rotation = await track.getRotation();
				try {
					t.fps = (await track.computeFrameRateMetrics()).bestGuessFrameRate;
				} catch {
					t.fps = null;
				}
			} else if (track.isAudioTrack()) {
				t.channels = await track.getNumberOfChannels();
				t.sampleRate = await track.getSampleRate();
			}
			info.push(t);
		}
		entry.tracks = info;

		// Duration: prefer fast metadata, fall back to precise computation.
		entry.duration = await input.getDurationFromMetadata();
		if (entry.duration == null) {
			const primaryVideo = trackObjs.find((t) => t.isVideoTrack());
			if (primaryVideo) entry.duration = await primaryVideo.getDurationFromMetadata();
		}
		if (entry.duration == null) entry.duration = await input.computeDuration();

		try {
			entry.title = (await input.getMetadataTags()).title || null;
		} catch {
			/* ignore */
		}

		// Bitrate of the primary video stream (for the overkill check).
		const primaryVideo = trackObjs.find((t) => t.isVideoTrack());
		if (primaryVideo) {
			const vInfo = info[trackObjs.indexOf(primaryVideo)];
			entry.video = {
				width: vInfo.width,
				height: vInfo.height,
				fps: vInfo.fps,
				codec: vInfo.codec,
				bitrate: vInfo.bitrate,
				bitrateSource: vInfo.bitrateSource,
			};
		}

		entry.status = 'ready';
		entry.decision = computeDecision(entry);
		updateCard(entry);
		refreshGlobalButtons();
	} catch (err) {
		entry.status = 'error';
		entry.error =
			err?.name === 'UnsupportedInputFormatError'
				? `Unsupported or unrecognized file format: ${entry.name}`
				: err?.message || String(err);
		entry.errorStack = err?.stack || '';
		updateCard(entry);
		refreshGlobalButtons();
	}
}

/* ================================================================== */
/*  Transcoding                                                       */
/* ================================================================== */

const DISCARD_REASON_TEXT = {
	discarded_by_user: 'removed by settings',
	max_track_count_reached: 'no room for more tracks in the output',
	max_track_count_of_type_reached: 'no room for more tracks of this type',
	unknown_source_codec: 'codec not recognized',
	undecodable_source_codec: 'codec cannot be decoded in this browser',
	no_encodable_target_codec: 'no encoder available for this codec',
};

function describeDiscarded(discarded) {
	if (!discarded.length) return '';
	return discarded
		.map((d) => `${d.kind} #${d.number} (${DISCARD_REASON_TEXT[d.reason] || d.reason})`)
		.join(' · ');
}

function queueTranscode(entry) {
	if (!webcodecsOk) return;
	if (!['ready', 'done', 'canceled'].includes(entry.status)) return;
	entry.status = 'queued';
	entry.error = null;
	entry.errorName = '';
	entry.errorStack = '';
	entry.errorAt = null;
	updateCard(entry);
	queue.push(entry.id);
	refreshGlobalButtons();
	processQueue();
}

function processQueue() {
	if (activeId != null) return;
	const id = queue.shift();
	if (id == null) return;
	const entry = files.get(id);
	if (!entry || entry.status !== 'queued') {
		processQueue();
		return;
	}
	activeId = id;
	runTranscode(entry);
}

async function runTranscode(entry) {
	entry.status = 'converting';
	entry.progress = 0;
	entry.bytesWritten = 0;
	entry.conversion = null;
	entry.decision = computeDecision(entry); // re-evaluate under current settings
	entry.discarded = [];
	// A new output is about to replace the old one — drop the old download URL.
	if (entry.objectUrl) {
		URL.revokeObjectURL(entry.objectUrl);
		entry.objectUrl = null;
	}
	entry.output = null;
	updateCard(entry);

	try {
		// Nothing needs to change: keep the original file as-is.
		const noConversion = entry.decision
			? entry.decision.action === 'passthrough'
			: shouldPassThrough(entry);
		if (noConversion) {
			entry.output = { blob: entry.file, size: entry.file.size, ext: null, passthrough: true };
			entry.status = 'done';
			entry.progress = 1;
			updateCard(entry);
			return;
		}

		const input = new Input({
			formats: ALL_FORMATS,
			source: new BlobSource(entry.file),
		});
		// Stream the output through a TransformStream so we can display the
		// output size live while encoding. Append-only writing requires an
		// append-only format layout (fragmented MP4 / append-only WebM).
		const outputFormat =
			settings.format === 'webm'
				? new WebMOutputFormat({ appendOnly: true })
				: new Mp4OutputFormat({ fastStart: 'fragmented' });
		const { writable, readable } = new TransformStream();
		const target = new AppendOnlyStreamTarget(writable);
		const output = new Output({ format: outputFormat, target });

		// Drain the readable side: counts bytes live and collects the output
		// chunks. Reading promptly also prevents backpressure from stalling
		// the encoder.
		const chunks = [];
		const reader = readable.getReader();
		const drain = (async () => {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				entry.bytesWritten += value.byteLength;
				updateProgress(entry);
			}
		})();

		const options = {
			input,
			output,
			tracks: 'primary', // only the primary video + primary audio track
			audio: fileVideoOnly(entry) ? { discard: true } : undefined,
		};
		if (entry.decision && entry.decision.reencode) {
			options.video = {
				quality: new Quality({
					bitrate: entry.decision.target,
					bitrateMode: 'variable',
				}),
			};
		}

		const conversion = await Conversion.init(options);
		entry.conversion = conversion;
		entry.discarded = conversion.discardedTracks.map((dt) => ({
			kind: dt.track.type,
			number: dt.track.number,
			reason: dt.reason,
		}));

		if (!conversion.isValid) {
			entry.status = 'error';
			entry.error =
				'Conversion is invalid. ' +
				(conversion.discardedTracks.length
					? 'Discarded tracks: ' +
					  conversion.discardedTracks
						.map(
							(dt) =>
								`${dt.track.type} #${dt.track.number} — ` +
								(DISCARD_REASON_TEXT[dt.reason] || dt.reason)
						)
						.join('; ')
					: 'No usable tracks left.');
			updateCard(entry);
			return;
		}

		conversion.onProgress = (p) => {
			entry.progress = p;
			updateProgress(entry);
		};
		updateCard(entry);

		await conversion.execute();

		if (conversion.state === 'canceled') {
			entry.status = 'canceled';
			updateCard(entry);
			return;
		}

		await drain; // the stream closes once the output is finalized
		const blob = new Blob(chunks, { type: outputFormat.mimeType });
		entry.output = { blob, size: blob.size, ext: settings.format };
		entry.status = 'done';
		entry.progress = 1;
		updateCard(entry);
	} catch (err) {
		if (err instanceof ConversionCanceledError) {
			entry.status = 'canceled';
		} else {
			entry.status = 'error';
			entry.error = err?.message || String(err);
			entry.errorName = err?.name || '';
			entry.errorStack = err?.stack || '';
			entry.errorAt = entry.progress; // how far into the file it got
		}
		updateCard(entry);
	} finally {
		activeId = null;
		refreshGlobalButtons();
		processQueue();
	}
}

function cancelTranscode(entry) {
	if (entry.status === 'converting' && entry.conversion) {
		entry.conversion.cancel().catch(() => {});
	} else if (entry.status === 'queued') {
		const i = queue.indexOf(entry.id);
		if (i !== -1) queue.splice(i, 1);
		entry.status = 'ready';
		updateCard(entry);
		refreshGlobalButtons();
	}
}

function removeFile(entry) {
	const i = queue.indexOf(entry.id);
	if (i !== -1) queue.splice(i, 1);
	if (activeId === entry.id) entry.conversion?.cancel().catch(() => {});
	if (modal.entry === entry) closeModal();
	files.delete(entry.id);
	entry.dom?.root.remove();
	if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
	refreshGlobalButtons();
	updateGlobalCheckbox();
}

/* ================================================================== */
/*  UI: card                                                          */
/* ================================================================== */

const STATUS_LABEL = {
	analyzing: 'analyzing…',
	ready: 'ready',
	queued: 'queued',
	converting: 'converting',
	done: 'done',
	canceled: 'canceled',
	error: 'error',
};

function buildCard(entry) {
	const root = el('article', 'card');
	root.id = `card-${entry.id}`;

	const head = el('div', 'card-head');
	const ident = el('div', 'file-ident');
	const name = el('div', 'file-name');
	name.textContent = entry.name;
	name.title = entry.name;
	const sub = el('div', 'file-sub');
	ident.append(name, sub);

	const controls = el('div', 'card-controls');
	const badge = el('span', 'badge');
	const btnTranscode = el('button', 'btn primary');
	btnTranscode.textContent = 'Transcode';
	const btnCancel = el('button', 'btn');
	btnCancel.textContent = 'Cancel';
	btnCancel.hidden = true;
	const btnRemove = el('button', 'btn danger');
	btnRemove.textContent = '✕';
	btnRemove.title = 'Remove file';
	controls.append(badge, btnTranscode, btnCancel, btnRemove);
	head.append(ident, controls);

	// per-file “video only” toggle (defaults to the global setting)
	const settingsRow = el('div', 'card-settings');
	const voLabel = el('label', 'card-setting');
	const voBox = document.createElement('input');
	voBox.type = 'checkbox';
	voBox.checked = fileVideoOnly(entry);
	voBox.title = 'Keep only the video stream(s) — remove audio and all other streams';
	voBox.addEventListener('change', () => setFileVideoOnly(entry, voBox.checked));
	const voText = el('span');
	voText.textContent = 'Video only';
	voLabel.append(voBox, voText);
	const voReset = el('button', 'btn small');
	voReset.textContent = '↺ follow global';
	voReset.title = 'Use the global “Video only” setting for this file';
	voReset.hidden = true;
	voReset.addEventListener('click', () => resetFileVideoOnly(entry));
	settingsRow.append(voLabel, voReset);

	const table = el('table', 'streams');
	const thead = el('thead');
	const headRow = el('tr');
	for (const h of ['#', 'Type', 'Codec', 'Details', 'Bitrate', 'Lang']) {
		const th = el('th');
		th.textContent = h;
		headRow.appendChild(th);
	}
	thead.appendChild(headRow);
	const tbody = el('tbody');
	table.append(thead, tbody);

	const decision = el('div', 'decision');
	const discarded = el('div', 'discarded');

	const progressArea = el('div', 'progress-area');
	progressArea.hidden = true;
	const progress = el('div', 'progress');
	const fill = el('div', 'progress-fill');
	progress.appendChild(fill);
	const progressMeta = el('div', 'progress-meta');
	progressArea.append(progress, progressMeta);

	const result = el('div', 'result');
	result.hidden = true;
	const error = el('div', 'card-error');

	root.append(head, settingsRow, table, decision, discarded, progressArea, result, error);

	btnTranscode.addEventListener('click', () => queueTranscode(entry));
	btnCancel.addEventListener('click', () => cancelTranscode(entry));
	btnRemove.addEventListener('click', () => removeFile(entry));

	return {
		root,
		sub,
		badge,
		btnTranscode,
		btnCancel,
		tbody,
		videoOnlyBox: voBox,
		videoOnlyReset: voReset,
		decision,
		discarded,
		progressArea,
		fill,
		progressMeta,
		result,
		error,
	};
}

function streamDetails(t) {
	const bits = [];
	if (t.kind === 'video') {
		if (t.width && t.height) bits.push(`${t.width}×${t.height}`);
		if (t.fps) bits.push(`${fmtFps(t.fps)} fps`);
		if (t.rotation && t.rotation % 360 !== 0) bits.push(`rot ${t.rotation}°`);
	} else if (t.kind === 'audio') {
		if (t.channels) bits.push(`${t.channels} ch`);
		if (t.sampleRate) bits.push(`${t.sampleRate / 1000} kHz`);
	}
	if (t.name) bits.push(`“${t.name}”`);
	return bits.join(' · ');
}

function renderStreams(entry) {
	const d = entry.dom;
	d.tbody.innerHTML = '';
	if (!entry.tracks) {
		const tr = el('tr');
		const td = el('td');
		td.colSpan = 6;
		td.textContent = 'analyzing…';
		tr.appendChild(td);
		d.tbody.appendChild(tr);
		return;
	}
	if (!entry.tracks.length) {
		const tr = el('tr');
		const td = el('td');
		td.colSpan = 6;
		td.textContent = 'no media tracks found';
		tr.appendChild(td);
		d.tbody.appendChild(tr);
		return;
	}
	// Tracks that will not be part of the output get marked in the table.
	// Pass-through keeps every stream of the original file — nothing marked.
	const dec = entry.decision;
	const passthrough = dec != null && dec.action === 'passthrough';
	const excluded = passthrough
		? new Set()
		: new Set(computeExcluded(entry).map((t) => `${t.kind}:${t.number}`));

	for (const t of entry.tracks) {
		const tr = el('tr');
		const isExcluded = excluded.has(`${t.kind}:${t.number}`);
		if (isExcluded) tr.className = 'excluded';
		const cells = [
			String(t.number),
			t.kind,
			t.codec || 'unknown',
			streamDetails(t),
			t.bitrate != null ? fmtBitrate(t.bitrate) : '—',
			t.lang && t.lang !== 'und' ? t.lang : '',
		];
		cells.forEach((text, i) => {
			const td = el('td');
			td.textContent = text;
			if (i === 1) {
				td.className = `type-${t.kind}`;
				if (isExcluded) {
					const b = el('span', 'badge-removed');
					b.textContent = ' ✂ removed';
					td.appendChild(b);
				}
			}
			tr.appendChild(td);
		});
		const titleBits = [];
		if (t.bitrate != null) titleBits.push(`bitrate: ${t.bitrateSource || 'unknown source'}`);
		if (isExcluded) titleBits.push('not included in output');
		tr.title = titleBits.join(' · ');
		d.tbody.appendChild(tr);
	}
}

/**
 * Predicted (setting-based) list of input tracks that will not be part of
 * the output: everything except the primary video track, and — unless
 * "video only" is enabled for this file — the primary audio track.
 */
function computeExcluded(entry) {
	if (!entry.tracks || !entry.tracks.length) return [];
	const keep = new Set();
	const v1 = entry.tracks.find((t) => t.kind === 'video');
	if (v1) keep.add(`video:${v1.number}`);
	if (!fileVideoOnly(entry)) {
		const a1 = entry.tracks.find((t) => t.kind === 'audio');
		if (a1) keep.add(`audio:${a1.number}`);
	}
	return entry.tracks.filter((t) => !keep.has(`${t.kind}:${t.number}`));
}

/**
 * What will happen to the primary audio track of this file. Audio is never
 * re-encoded unnecessarily: when the output format can store the source
 * codec, the stream is copied as-is; otherwise (e.g. AAC audio into WebM)
 * it is re-encoded to a codec the format supports.
 */
function describeAudioAction(entry) {
	if (fileVideoOnly(entry)) return '';
	// Pass-through keeps the original file untouched — no conversion, so no
	// per-track prediction is needed (the chip already says so).
	if (entry.decision?.action === 'passthrough') return '';
	const a1 = entry.tracks?.find((t) => t.kind === 'audio');
	if (!a1 || !a1.codec) return '';
	const supported =
		(settings.format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat())
			.getSupportedAudioCodecs();
	const fmtName = settings.format === 'webm' ? 'WebM' : 'MP4';
	if (supported.includes(a1.codec)) {
		return `Audio: ${a1.codec} will be copied, not re-encoded`;
	}
	return `Audio: ${a1.codec} will be re-encoded (${a1.codec} cannot be stored in ${fmtName})`;
}

function renderDecision(entry) {
	const d = entry.dom;
	d.decision.innerHTML = '';
	d.discarded.textContent = '';
	if (!entry.tracks) return;

	if (!entry.video) {
		const chip = el('span', 'chip info');
		chip.textContent = 'no video stream';
		const note = el('span', 'note');
		note.textContent = 'This file contains no video stream (audio/data only).';
		d.decision.append(chip, note);
		return;
	}

	const dec = entry.decision;
	if (!dec) return;
	const chip = el('span', `chip ${dec.reencode ? 'warn' : 'ok'}`);
	chip.textContent =
		dec.action === 'reencode' ? `re-encode → ~${fmtBitrate(dec.target)}`
		: dec.action === 'passthrough' ? 'no conversion — original file kept'
		: dec.action === 'remux-audio-removed' ? 'remux — video copied, audio removed'
		: `remux — video copied → ${settings.format === 'webm' ? 'WebM' : 'MP4'}`;
	const note = el('span', 'note');
	note.textContent = dec.note || '';
	d.decision.append(chip, note);

	// pass-through keeps every stream of the original file
	const excluded = dec.action === 'passthrough' ? [] : computeExcluded(entry);
	const parts = [];
	if (excluded.length) {
		parts.push(
			`Not included in output: ${excluded
				.map((t) => `${t.kind} #${t.number} (${t.codec || 'unknown'})`)
				.join(' · ')}`
		);
	}
	const audioAction = describeAudioAction(entry);
	if (audioAction) parts.push(audioAction);
	const disc = describeDiscarded(entry.discarded);
	if (disc) parts.push(`Discarded: ${disc}`);
	d.discarded.textContent = parts.join(' · ');
}

const PREVIEW_ERROR_TEXT = {
	1: 'aborted',
	2: 'network error',
	3: 'decode error',
	4: 'source not supported by this browser',
};

/**
 * Start (or restart) the in-card preview of the transcoded output.
 * The preview is muted & looping: muted autoplay is always permitted, and
 * the audio track is still decoded, so audio problems are caught too.
 */
function startPreview(entry) {
	const video = entry.dom.preview;
	const status = entry.dom.previewStatus;
	if (!video || !status || !entry.objectUrl) return;
	if (video.src === entry.objectUrl && video.readyState >= 2) return;
	video.src = entry.objectUrl;
	status.className = 'preview-status';
	status.textContent = 'previewing…';
	video.play().catch(() => {
		if (status.textContent === 'previewing…') {
			status.className = 'preview-status warn';
			status.textContent = 'autoplay blocked — click the preview';
		}
	});
}

function renderResult(entry) {
	const d = entry.dom;
	if (!entry.output) {
		d.result.hidden = true;
		d.result.innerHTML = '';
		d.preview = null;
		d.previewStatus = null;
		return;
	}
	d.result.hidden = false;
	d.result.innerHTML = '';

	if (!entry.objectUrl) entry.objectUrl = URL.createObjectURL(entry.output.blob);
	const isPT = !!entry.output.passthrough;
	const diff = 1 - entry.output.size / entry.size;
	const diffText = `${diff >= 0 ? '−' : '+'}${Math.abs(Math.round(diff * 100))}%`;

	const top = el('div', 'result-top');
	const line = el('div', 'result-line');
	line.textContent = isPT
		? `No conversion — original file kept as-is (${fmtBytes(entry.output.size)})`
		: `Result: ${fmtBytes(entry.output.size)} (${diffText} vs input)`;
	const actions = el('div', 'result-actions');
	const dl = document.createElement('a');
	dl.className = 'btn primary';
	dl.href = entry.objectUrl;
	const dlName = isPT ? entry.name : outputName(entry.name, entry.output.ext);
	dl.download = dlName;
	dl.textContent = isPT ? `Download original file` : `Download ${dlName}`;
	const playBtn = el('button', 'btn');
	playBtn.textContent = 'Play ▸';
	playBtn.title = 'Open in a bigger window';
	playBtn.addEventListener('click', () => openModal(entry));
	actions.append(dl, playBtn);
	top.append(line, actions);

	const status = el('span', 'preview-status');
	const video = el('video', 'preview');
	video.playsInline = true;
	video.muted = true;
	video.loop = true;
	video.preload = 'auto';
	video.title = 'Click to open in a bigger window';
	video.addEventListener('click', () => openModal(entry));
	video.addEventListener('playing', () => {
		status.className = 'preview-status ok';
		status.textContent = 'preview OK ✓';
	});
	video.addEventListener('error', () => {
		if (!video.error) return;
		const code = video.error.code;
		status.className = 'preview-status err';
		status.textContent = `preview error: ${PREVIEW_ERROR_TEXT[code] || 'unknown'} (code ${code})`;
	});
	const wrap = el('div', 'preview-wrap');
	wrap.append(video, status);

	d.result.append(top, wrap);
	d.preview = video;
	d.previewStatus = status;

	// Auto-preview the converted video as soon as transcoding is done,
	// so that any encoding errors become visible right away.
	if (entry.status === 'done') startPreview(entry);
}

/* ================================================================== */
/*  Full-window preview modal                                          */
/* ================================================================== */

const modal = {
	root: document.getElementById('modal'),
	title: document.getElementById('modal-title'),
	video: document.getElementById('modal-video'),
	status: document.getElementById('modal-status'),
	entry: null,
};

// The modal <video> is persistent, so attach the error handler once:
// if the converted output cannot be played, say why instead of failing silently.
modal.video.addEventListener('error', () => {
	if (!modal.video.error) return;
	const code = modal.video.error.code;
	modal.status.textContent = `cannot play: ${
		PREVIEW_ERROR_TEXT[code] || 'unknown error'
	} (code ${code}) — the output may be damaged or use a format this browser cannot decode`;
	modal.status.classList.remove('hidden');
});

function openModal(entry) {
	if (!entry.output || !entry.objectUrl) return;
	closeModal(); // release any previous video
	modal.entry = entry;
	modal.title.textContent = entry.output.passthrough
		? entry.name
		: `${entry.name} → ${outputName(entry.name, entry.output.ext)}`;
	modal.video.src = entry.objectUrl;
	modal.status.classList.add('hidden');
	modal.root.classList.remove('hidden');
	modal.video.play().catch(() => {}); // user can press the modal's play control
}

function closeModal() {
	if (modal.root.classList.contains('hidden')) return;
	modal.video.pause();
	modal.video.removeAttribute('src');
	modal.video.load();
	modal.root.classList.add('hidden');
	modal.entry = null;
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-backdrop').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') closeModal();
});

function updateCard(entry) {
	const d = entry.dom;
	if (!d) return;

	d.badge.textContent = STATUS_LABEL[entry.status] || entry.status;
	d.badge.className = `badge ${entry.status}`;
	d.root.classList.toggle('converting', entry.status === 'converting');

	// file subtitle: size · duration · title · N streams
	d.sub.innerHTML = '';
	const sizeSpan = el('span');
	sizeSpan.textContent = fmtBytes(entry.size);
	d.sub.appendChild(sizeSpan);
	const extra = [];
	if (entry.duration != null) extra.push(fmtDuration(entry.duration));
	if (entry.title) extra.push(`“${entry.title}”`);
	if (entry.tracks) extra.push(`${entry.tracks.length} stream${entry.tracks.length === 1 ? '' : 's'}`);
	extra.forEach((text) => {
		const sep = el('span', 'sep');
		sep.textContent = '·';
		const s = el('span');
		s.textContent = text;
		d.sub.append(sep, s);
	});

	renderStreams(entry);
	renderDecision(entry);

	// per-file “video only” toggle: checked state + “follow global” reset
	d.videoOnlyBox.checked = fileVideoOnly(entry);
	d.videoOnlyReset.hidden = entry.videoOnlyOverride === null;

	// buttons
	const busy = entry.status === 'queued' || entry.status === 'converting';
	d.btnTranscode.disabled = busy || !webcodecsOk || entry.status === 'error' || entry.status === 'analyzing';
	d.btnTranscode.textContent = entry.status === 'done' ? 'Re-transcode' : 'Transcode';
	d.btnCancel.hidden = !busy;

	// progress area visibility
	const showProgress =
		entry.status === 'converting' ||
		entry.status === 'queued' ||
		(entry.status === 'done' && entry.progress > 0);
	d.progressArea.hidden = !showProgress;
	if (!showProgress) d.fill.style.width = '0%';

	// progress text
	if (entry.status === 'converting') {
		d.progressMeta.textContent = `${Math.round(entry.progress * 100)}% · ${fmtBytes(entry.bytesWritten)} written`;
	} else if (entry.status === 'queued') {
		d.progressMeta.textContent = 'waiting to start…';
	} else if (entry.status === 'done') {
		d.progressMeta.textContent = 'complete';
	}

	renderResult(entry);
	renderError(entry);
}

/**
 * Render the card's error area with as much diagnostic context as
 * available: the message, where the conversion got stuck, a hint for
 * decoder errors (usually a corrupted source file) and the full stack
 * behind a <details> element.
 */
function renderError(entry) {
	const d = entry.dom;
	d.error.innerHTML = '';
	if (!entry.error) return;

	const msg = el('div', 'error-msg');
	msg.textContent = entry.error;
	d.error.appendChild(msg);

	if (entry.errorAt != null && entry.errorAt > 0 && entry.errorAt < 1) {
		const sub = el('div', 'error-sub');
		sub.textContent = `failed at ~${Math.round(entry.errorAt * 100)}% into the file`;
		d.error.appendChild(sub);
	}

	// Decoder failures usually mean the source stream itself is damaged or
	// uses a format this browser cannot decode. Browsers' decoders are
	// strict and stop at the first unrecoverable frame, while tools like
	// ffmpeg resync and continue — so a re-encode often salvages the file.
	if (/decoder|decod/i.test(`${entry.errorName || ''} ${entry.error}`)) {
		const hint = el('div', 'error-hint');
		const p = document.createElement('div');
		p.textContent =
			'The video stream could not be decoded — the source file may be ' +
			'corrupted. Re-encoding it with ffmpeg often recovers such files:';
		const code = document.createElement('code');
		code.textContent =
			`ffmpeg -i ${entry.name} -c:v libx264 -preset fast -crf 20 -c:a copy repaired.mp4`;
		const p2 = document.createElement('div');
		p2.textContent = '…then convert repaired.mp4 here.';
		hint.append(p, code, p2);
		d.error.appendChild(hint);
	}

	if (entry.errorStack || entry.errorName) {
		const det = document.createElement('details');
		const sum = document.createElement('summary');
		sum.textContent = `technical details${entry.errorName ? ` — ${entry.errorName}` : ''}`;
		const pre = document.createElement('pre');
		pre.textContent = entry.errorStack || entry.errorName;
		det.append(sum, pre);
		d.error.appendChild(det);
	}
}

/* Throttled progress painting (rAF). */
let progressRaf = 0;
const pendingProgress = new Set();

function updateProgress(entry) {
	pendingProgress.add(entry);
	if (!progressRaf) {
		progressRaf = requestAnimationFrame(() => {
			progressRaf = 0;
			for (const e of pendingProgress) {
				e.dom.fill.style.width = `${(e.progress * 100).toFixed(1)}%`;
				if (e.status === 'converting') {
					e.dom.progressMeta.textContent = `${Math.round(e.progress * 100)}% · ${fmtBytes(e.bytesWritten)} written`;
				}
			}
			pendingProgress.clear();
		});
	}
}

/* ================================================================== */
/*  Global buttons & input                                            */
/* ================================================================== */

function refreshGlobalButtons() {
	const anyTranscodable = [...files.values()].some((f) =>
		['ready', 'done', 'canceled'].includes(f.status)
	);
	els.transcodeAll.disabled = !anyTranscodable || !webcodecsOk;
	els.clear.disabled = files.size === 0;
}

els.transcodeAll.addEventListener('click', () => {
	for (const e of files.values()) {
		if (['ready', 'done', 'canceled'].includes(e.status)) queueTranscode(e);
	}
});

els.clear.addEventListener('click', () => {
	for (const e of [...files.values()]) removeFile(e);
});

/* file picker */
els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' || e.key === ' ') els.fileInput.click();
});
els.fileInput.addEventListener('change', () => {
	if (els.fileInput.files.length) addFiles(els.fileInput.files);
	els.fileInput.value = '';
});

/* drag & drop */
['dragenter', 'dragover'].forEach((ev) =>
	els.dropzone.addEventListener(ev, (e) => {
		e.preventDefault();
		els.dropzone.classList.add('drag');
	})
);
['dragleave', 'drop'].forEach((ev) =>
	els.dropzone.addEventListener(ev, (e) => {
		e.preventDefault();
		els.dropzone.classList.remove('drag');
	})
);
els.dropzone.addEventListener('drop', (e) => {
	if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

/* init */
applySettingsToUi();
refreshGlobalButtons();

/* Test / automation hook: add files programmatically, e.g.
 *   const b = await (await fetch('/tests/x.mp4')).blob();
 *   window.__wt.addFiles(new File([b], 'x.mp4')); */
window.__wt = {
	addFiles: (list) => addFiles(list),
	files,
	settings: () => settings,
};
