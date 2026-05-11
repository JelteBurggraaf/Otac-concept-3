const express = require('express');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { spawn } = require('child_process');
const multer  = require('multer');
const QRCode  = require('qrcode');
const db      = require('./db');

const app  = express();
const PORT = 3000;

app.use(express.json());

// Serve main installation and admin UI from parent directory
// HTML files get no-store so the kiosk browser always picks up code changes
app.use(express.static(path.join(__dirname, '..'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSentencesWithOptions(type) {
  const rows = db.prepare('SELECT * FROM sentences WHERE type = ?').all(type);
  const getOpts = db.prepare('SELECT id, text, correct FROM options WHERE sentence_id = ?');
  return rows.map(s => ({ ...s, options: getOpts.all(s.id) }));
}

// Fisher-Yates shuffle — unbiased random pick
function randomPick(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}

// Settings helpers — avoids repeating the same prepared statement everywhere
const _getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const _setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
function getSetting(key, fallback = '') { return _getSetting.get(key)?.value ?? fallback; }
function setSetting(key, value)        { _setSetting.run(key, String(value)); }

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/sentences/round?trainable=10&nonsense=6
app.get('/api/sentences/round', (req, res) => {
  const tCount = parseInt(req.query.trainable) || 10;
  const nCount = parseInt(req.query.nonsense)  || 6;

  const trainable = randomPick(getSentencesWithOptions('trainable'), tCount);
  const nonsense  = randomPick(getSentencesWithOptions('nonsense'),  nCount);

  res.json({ trainable, nonsense });
});

// GET /api/sentences — all sentences with options
app.get('/api/sentences', (req, res) => {
  const trainable = getSentencesWithOptions('trainable');
  const nonsense  = getSentencesWithOptions('nonsense');
  res.json({ trainable, nonsense });
});

// POST /api/sentences — create sentence + options
// Body: { text, type, options: [{ text, correct }] }
app.post('/api/sentences', (req, res) => {
  const { text, type, options } = req.body;
  if (!text || !type || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: 'text, type, and at least 2 options required' });
  }

  const insert = db.transaction(() => {
    const { lastInsertRowid: sid } = db.prepare('INSERT INTO sentences (text, type) VALUES (?, ?)').run(text.trim(), type);
    const insertOpt = db.prepare('INSERT INTO options (sentence_id, text, correct) VALUES (?, ?, ?)');
    for (const opt of options) insertOpt.run(sid, opt.text.trim(), opt.correct ? 1 : 0);
    return sid;
  });

  const id = insert();
  const row = db.prepare('SELECT * FROM sentences WHERE id = ?').get(id);
  const opts = db.prepare('SELECT id, text, correct FROM options WHERE sentence_id = ?').all(id);
  res.status(201).json({ ...row, options: opts });
});

// PUT /api/sentences/:id — replace sentence text/type and all options
app.put('/api/sentences/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { text, type, options } = req.body;
  if (!text || !type || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: 'text, type, and at least 2 options required' });
  }

  const update = db.transaction(() => {
    db.prepare('UPDATE sentences SET text = ?, type = ? WHERE id = ?').run(text.trim(), type, id);
    db.prepare('DELETE FROM options WHERE sentence_id = ?').run(id);
    const insertOpt = db.prepare('INSERT INTO options (sentence_id, text, correct) VALUES (?, ?, ?)');
    for (const opt of options) insertOpt.run(id, opt.text.trim(), opt.correct ? 1 : 0);
  });

  update();
  const row = db.prepare('SELECT * FROM sentences WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const opts = db.prepare('SELECT id, text, correct FROM options WHERE sentence_id = ?').all(id);
  res.json({ ...row, options: opts });
});

// DELETE /api/sentences/:id
app.delete('/api/sentences/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const info = db.prepare('DELETE FROM sentences WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Game control ──────────────────────────────────────────────────────────────

let gameProgress = { phase: 'idle', mode: 'input', mastered: 0, total: 0 };

// POST /api/game/progress — main page reports its live state
app.post('/api/game/progress', (req, res) => {
  const { phase, mode, mastered, total } = req.body;
  gameProgress = { phase, mode, mastered: mastered ?? 0, total: total ?? 0 };
  res.json({ ok: true });
});

// GET /api/game/progress — admin page reads live state
app.get('/api/game/progress', (req, res) => {
  res.json(gameProgress);
});

// GET /api/game/state — lightweight poll endpoint for the main page
app.get('/api/game/state', (req, res) => {
  res.json({
    reset_token:      parseInt(getSetting('reset_token', '0')),
    dial_sensitivity: parseFloat(getSetting('dial_sensitivity', '0.5')),
    quiz_sensitivity: parseInt(getSetting('quiz_sensitivity', '90')),
  });
});

// POST /api/game/reset — increment token so main page resets on next poll
app.post('/api/game/reset', (req, res) => {
  const next = parseInt(getSetting('reset_token', '0')) + 1;
  setSetting('reset_token', next);
  res.json({ ok: true, reset_token: next });
});

// ── Video settings ────────────────────────────────────────────────────────────

const ROOT       = path.join(__dirname, '..');
const VIDEO_ROOT = path.join(ROOT, 'video');
const VIDEO_EXTS = new Set(['.webm', '.mp4', '.mov', '.ogg']);
fs.mkdirSync(VIDEO_ROOT, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, VIDEO_ROOT),
    filename:    (_req, file,  cb) => cb(null, file.originalname),
  }),
  fileFilter: (_req, file, cb) =>
    cb(null, VIDEO_EXTS.has(path.extname(file.originalname).toLowerCase())),
});

// GET /api/videos — list video files in the project root
app.get('/api/videos', (req, res) => {
  const files = fs.readdirSync(VIDEO_ROOT).filter(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()));
  res.json({ files, active: getSetting('active_video') });
});

// PUT /api/settings/video — set active video
app.put('/api/settings/video', (req, res) => {
  const { filename } = req.body;
  if (!filename || !VIDEO_EXTS.has(path.extname(filename).toLowerCase())) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  setSetting('active_video', filename);
  res.json({ ok: true, active: filename });
});

// GET /api/settings — return all settings
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

// PUT /api/settings/:key — set a single setting value
app.put('/api/settings/:key', (req, res) => {
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'Missing value' });
  setSetting(req.params.key, value);
  res.json({ ok: true });
});

// ── Module participant codes ───────────────────────────────────────────────────

function fmtCode(n) { return String(Math.max(0, parseInt(n) || 0)).padStart(4, '0'); }

// GET /api/modules/counts — active sessions for admin display
app.get('/api/modules/counts', (req, res) => {
  const currentQrSessionId = parseInt(getSetting('current_qr_session', '0')) || null;
  // Show newest active sessions first; always include current QR session even if all modules done
  const sessions = db.prepare(`
    SELECT id, c1, c2, c3, m1_done, m2_done, m3_done FROM sessions
    WHERE (m1_done=0 OR m2_done=0 OR m3_done=0) OR id = ?
    ORDER BY id DESC LIMIT 6
  `).all(currentQrSessionId ?? 0);
  res.json({ sessions, currentQrSessionId });
});

// GET /api/session/new — atomically reserve codes for all 3 modules and generate QR
app.get('/api/session/new', async (req, res) => {
  const reserve = db.transaction(() => {
    const n1 = parseInt(getSetting('module1_count', '0')) + 1;
    const n2 = parseInt(getSetting('module2_count', '0')) + 1;
    const n3 = parseInt(getSetting('module3_count', '0')) + 1;
    setSetting('module1_count', n1);
    setSetting('module2_count', n2);
    setSetting('module3_count', n3);
    const c1 = fmtCode(n1), c2 = fmtCode(n2), c3 = fmtCode(n3);
    const { lastInsertRowid: sessionId } = db.prepare('INSERT INTO sessions (c1,c2,c3) VALUES (?,?,?)').run(c1, c2, c3);
    setSetting('current_qr_session', sessionId);
    return { c1, c2, c3, sessionId };
  });
  const { c1, c2, c3, sessionId } = reserve();
  const token   = Buffer.from([c1, c2, c3].join(',')).toString('base64url');
  const examUrl = (getSetting('exam_url', '') || 'https://otac-guide.netlify.app').replace(/\/$/, '');
  const url     = examUrl + '/sessie/' + token;
  const qr      = await QRCode.toDataURL(url, { width: 300, margin: 2 });
  res.json({ token, c1, c2, c3, url, qr, sessionId });
});

// POST /api/session/start — mark a session as started (player turned the dial to begin)
app.post('/api/session/start', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  db.prepare('UPDATE sessions SET started = 1 WHERE id = ?').run(id);
  res.json({ ok: true });
});

// POST /api/modules/:id/complete — mark session done, return pre-allocated code
// Module 1: uses exact sessionId from the installation (guaranteed match with QR token)
// Module 2: oldest session where m1_done=1 (player completed module 1 first)
// Module 3: oldest session where m2_done=1 (player completed module 2 first)
app.post('/api/modules/:id/complete', (req, res) => {
  const id = parseInt(req.params.id);
  if (![1,2,3].includes(id)) return res.status(400).json({ error: 'Invalid module id' });
  const col  = `m${id}_done`;
  const cCol = `c${id}`;
  const mark = db.transaction(() => {
    let session;
    if (id === 1 && req.body?.sessionId) {
      session = db.prepare(
        `SELECT id, ${cCol} as code FROM sessions WHERE id = ? AND ${col} = 0`
      ).get(req.body.sessionId);
    } else {
      const prereq = id > 1 ? `AND m${id - 1}_done = 1` : '';
      session = db.prepare(
        `SELECT id, ${cCol} as code FROM sessions WHERE ${col} = 0 AND started = 1 ${prereq} ORDER BY id ASC LIMIT 1`
      ).get();
    }
    if (!session) return null;
    db.prepare(`UPDATE sessions SET ${col} = 1 WHERE id = ?`).run(session.id);
    return session.code;
  });
  const code = mark();
  if (!code) return res.status(409).json({ error: 'No active session for this module.' });
  res.json({ code });
});

// PATCH /api/sessions/:sid/modules/:mid — manually set m1/m2/m3_done
app.patch('/api/sessions/:sid/modules/:mid', (req, res) => {
  const sid = parseInt(req.params.sid);
  const mid = parseInt(req.params.mid);
  if (![1,2,3].includes(mid)) return res.status(400).json({ error: 'Invalid module id' });
  const col  = `m${mid}_done`;
  const done = req.body?.done ? 1 : 0;
  const r = db.prepare(`UPDATE sessions SET ${col} = ? WHERE id = ?`).run(done, sid);
  if (r.changes === 0) return res.status(404).json({ error: 'Session not found' });
  res.json({ ok: true });
});

// DELETE /api/videos/:filename — delete a video file from the project root
app.delete('/api/videos/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!VIDEO_EXTS.has(path.extname(filename).toLowerCase())) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filepath = path.join(VIDEO_ROOT, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  fs.unlink(filepath, err => {
    if (err) return res.status(500).json({ error: 'Could not delete file' });
    if (getSetting('active_video') === filename) setSetting('active_video', '');
    res.json({ ok: true });
  });
});

// POST /api/videos/upload — upload a ready-to-use video file to the project root
app.post('/api/videos/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No valid video file received' });
  res.json({ ok: true, filename: req.file.filename });
});

// ── Video conversion (ffmpeg) ─────────────────────────────────────────────────

const FFMPEG_PATHS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
function findFfmpeg() {
  return FFMPEG_PATHS.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
}

// Multer for conversion input — save to temp dir, accept any video
const uploadForConvert = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename:    (_req, file,  cb) => cb(null, 'oltc-' + Date.now() + path.extname(file.originalname)),
  }),
});

const convertJobs = new Map(); // jobId -> { status, progress, filename, error }

// POST /api/videos/convert — start a conversion job
app.post('/api/videos/convert', uploadForConvert.single('video'), (req, res) => {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return res.status(500).json({ error: 'ffmpeg niet gevonden. Installeer via: brew install ffmpeg' });
  if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen' });

  const base   = path.basename(req.file.originalname, path.extname(req.file.originalname));
  const output = path.join(VIDEO_ROOT, base + '.webm');
  const jobId  = Date.now().toString();

  convertJobs.set(jobId, { status: 'running', progress: 0, filename: base + '.webm' });
  res.json({ jobId, filename: base + '.webm' });

  const proc = spawn(ffmpeg, [
    '-i', req.file.path,
    '-vf', 'scale=1280:720',
    '-c:v', 'libvpx',
    '-g', '15', '-keyint_min', '15',
    '-b:v', '1500k',
    '-quality', 'good', '-cpu-used', '2',
    '-c:a', 'libvorbis', '-b:a', '96k',
    output, '-y',
  ]);

  let duration = 0;
  proc.stderr.on('data', chunk => {
    const s = chunk.toString();
    const dm = s.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (dm) duration = +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]);
    const tm = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (tm && duration > 0) {
      const t = +tm[1] * 3600 + +tm[2] * 60 + parseFloat(tm[3]);
      convertJobs.get(jobId).progress = Math.min(99, Math.round(t / duration * 100));
    }
  });

  proc.on('close', code => {
    fs.unlink(req.file.path, () => {});
    const job = convertJobs.get(jobId);
    if (code === 0) { job.status = 'done'; job.progress = 100; }
    else            { job.status = 'error'; job.error = `ffmpeg exited with code ${code}`; }
    // Clean up job from memory after 5 minutes
    setTimeout(() => convertJobs.delete(jobId), 5 * 60 * 1000);
  });
});

// GET /api/videos/convert/:jobId — poll conversion progress
app.get('/api/videos/convert/:jobId', (req, res) => {
  const job = convertJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Onbekende taak' });
  res.json(job);
});

// ── Audio files ───────────────────────────────────────────────────────────────

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a']);
const AUDIO_ROOT = path.join(ROOT, 'audio');
fs.mkdirSync(AUDIO_ROOT, { recursive: true });

const uploadAudio = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AUDIO_ROOT),
    filename:    (_req, file,  cb) => cb(null, file.originalname),
  }),
  fileFilter: (_req, file, cb) =>
    cb(null, AUDIO_EXTS.has(path.extname(file.originalname).toLowerCase())),
});

// GET /api/audio — list audio files
app.get('/api/audio', (req, res) => {
  const files = fs.readdirSync(AUDIO_ROOT).filter(f => AUDIO_EXTS.has(path.extname(f).toLowerCase()));
  res.json({ files });
});

// POST /api/audio/upload — upload audio file
app.post('/api/audio/upload', uploadAudio.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No valid audio file received' });
  res.json({ ok: true, filename: req.file.filename });
});

// POST /api/audio/duplicate/:filename — copy audio file with _copy suffix
app.post('/api/audio/duplicate/:filename', (req, res) => {
  const filename = req.params.filename;
  const ext = path.extname(filename).toLowerCase();
  if (!AUDIO_EXTS.has(ext)) return res.status(400).json({ error: 'Invalid filename' });
  const src = path.join(AUDIO_ROOT, filename);
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'File not found' });
  const base = path.basename(filename, ext);
  let newName, i = 1;
  do { newName = `${base}_copy${i > 1 ? i : ''}${ext}`; i++; }
  while (fs.existsSync(path.join(AUDIO_ROOT, newName)));
  fs.copyFile(src, path.join(AUDIO_ROOT, newName), err => {
    if (err) return res.status(500).json({ error: 'Could not duplicate file' });
    res.json({ ok: true, filename: newName });
  });
});

// DELETE /api/audio/:filename — delete audio file
app.delete('/api/audio/:filename', (req, res) => {
  const filename = req.params.filename;
  if (!AUDIO_EXTS.has(path.extname(filename).toLowerCase())) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filepath = path.join(AUDIO_ROOT, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  fs.unlink(filepath, err => {
    if (err) return res.status(500).json({ error: 'Could not delete file' });
    res.json({ ok: true });
  });
});

// ── Bias module ───────────────────────────────────────────────────────────────

// GET /api/bias/state — reset token poll for main page
app.get('/api/bias/state', (req, res) => {
  res.json({ bias_reset_token: parseInt(getSetting('bias_reset_token', '0')) });
});

// POST /api/bias/reset — admin triggers reset
app.post('/api/bias/reset', (req, res) => {
  const next = parseInt(getSetting('bias_reset_token', '0')) + 1;
  setSetting('bias_reset_token', next);
  res.json({ ok: true, bias_reset_token: next });
});

// Bias progress (in-memory)
let biasProgress = { state: 'idle', streak: 0, storyName: '' };
let ioState = { mode: 'input', encoder_at: 0, encoder_steps: 0, sensor_value: null, sensor_in_range: false, btn_left_at: 0, btn_right_at: 0, pump_at: 0, pump_high_at: 0, pump_low_at: 0, pump_cheat_at: 0 };

// POST /api/bias/progress
app.post('/api/bias/progress', (req, res) => {
  const { state, streak, storyName } = req.body;
  biasProgress = { state: state ?? 'idle', streak: streak ?? 0, storyName: storyName ?? '' };
  res.json({ ok: true });
});

// GET /api/bias/progress
app.get('/api/bias/progress', (req, res) => {
  res.json(biasProgress);
});

// GET /api/io/state
app.get('/api/io/state', (req, res) => res.json(ioState));

// POST /api/io/update
app.post('/api/io/update', (req, res) => { Object.assign(ioState, req.body); res.json({ ok: true }); });

// GET /api/bias/config
app.get('/api/bias/config', (req, res) => {
  res.json({
    start_audio:          getSetting('bias_start_audio'),
    final_audio:          getSetting('bias_final_audio'),
    middle_correct_audio: getSetting('bias_middle_correct_audio'),
    wrong_audio:          getSetting('bias_wrong_audio'),
    second_wrong_audio:   getSetting('bias_second_wrong_audio'),
    sensor_min:           getSetting('bias_sensor_min') || '0',
    sensor_max:           getSetting('bias_sensor_max') || '1023',
  });
});

// PUT /api/bias/config
app.put('/api/bias/config', (req, res) => {
  const { start_audio, final_audio, middle_correct_audio, wrong_audio, second_wrong_audio, sensor_min, sensor_max } = req.body;
  setSetting('bias_start_audio',          start_audio          ?? '');
  setSetting('bias_final_audio',          final_audio          ?? '');
  setSetting('bias_middle_correct_audio', middle_correct_audio ?? '');
  setSetting('bias_wrong_audio',          wrong_audio          ?? '');
  setSetting('bias_second_wrong_audio',   second_wrong_audio   ?? '');
  if (sensor_min !== undefined) setSetting('bias_sensor_min', sensor_min);
  if (sensor_max !== undefined) setSetting('bias_sensor_max', sensor_max);
  res.json({ ok: true });
});

// GET /api/bias/stories
app.get('/api/bias/stories', (req, res) => {
  res.json(db.prepare('SELECT * FROM bias_stories').all());
});

// POST /api/bias/stories
app.post('/api/bias/stories', (req, res) => {
  const { name, story_audio, correct_button } = req.body;
  if (!name || !story_audio || !correct_button) {
    return res.status(400).json({ error: 'All fields required' });
  }
  const { lastInsertRowid: id } = db.prepare(
    'INSERT INTO bias_stories (name, story_audio, correct_audio, wrong_audio, correct_button) VALUES (?, ?, ?, ?, ?)'
  ).run(name, story_audio, '', '', correct_button);
  res.status(201).json(db.prepare('SELECT * FROM bias_stories WHERE id = ?').get(id));
});

// PUT /api/bias/stories/:id
app.put('/api/bias/stories/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { name, story_audio, correct_button } = req.body;
  if (!name || !story_audio || !correct_button) {
    return res.status(400).json({ error: 'All fields required' });
  }
  db.prepare(
    'UPDATE bias_stories SET name=?, story_audio=?, correct_button=? WHERE id=?'
  ).run(name, story_audio, correct_button, id);
  const row = db.prepare('SELECT * FROM bias_stories WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// POST /api/bias/stories/:id/duplicate
app.post('/api/bias/stories/:id/duplicate', (req, res) => {
  const story = db.prepare('SELECT * FROM bias_stories WHERE id = ?').get(parseInt(req.params.id));
  if (!story) return res.status(404).json({ error: 'Not found' });
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO bias_stories (name, story_audio, correct_audio, wrong_audio, correct_button) VALUES (?, ?, ?, ?, ?)'
  ).run(story.name + ' (kopie)', story.story_audio, '', '', story.correct_button);
  res.json({ ok: true, id: lastInsertRowid });
});

// DELETE /api/bias/stories/:id
app.delete('/api/bias/stories/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const info = db.prepare('DELETE FROM bias_stories WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Pump module ───────────────────────────────────────────────────────────────

// GET /api/pump/config
app.get('/api/pump/config', (req, res) => {
  res.json({
    required:      parseInt(getSetting('pump_required',      '8')),
    word_duration: parseInt(getSetting('pump_word_duration', '3000')),
  });
});

// PUT /api/pump/config
app.put('/api/pump/config', (req, res) => {
  const { required, word_duration } = req.body;
  if (required      !== undefined) setSetting('pump_required',      required);
  if (word_duration !== undefined) setSetting('pump_word_duration', word_duration);
  res.json({ ok: true });
});

// GET /api/pump/words
app.get('/api/pump/words', (req, res) => {
  res.json(db.prepare('SELECT * FROM pump_words ORDER BY id').all());
});

// POST /api/pump/words
app.post('/api/pump/words', (req, res) => {
  const { word, is_correct } = req.body;
  if (!word) return res.status(400).json({ error: 'word required' });
  const { lastInsertRowid: id } = db.prepare(
    'INSERT INTO pump_words (word, is_correct) VALUES (?, ?)'
  ).run(word.trim(), is_correct ? 1 : 0);
  res.status(201).json(db.prepare('SELECT * FROM pump_words WHERE id = ?').get(id));
});

// PUT /api/pump/words/:id
app.put('/api/pump/words/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { word, is_correct } = req.body;
  if (!word) return res.status(400).json({ error: 'word required' });
  db.prepare('UPDATE pump_words SET word=?, is_correct=? WHERE id=?').run(word.trim(), is_correct ? 1 : 0, id);
  const row = db.prepare('SELECT * FROM pump_words WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// DELETE /api/pump/words/:id
app.delete('/api/pump/words/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const info = db.prepare('DELETE FROM pump_words WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`OLTC server running at http://localhost:${PORT}`);
  console.log(`  Main app : http://localhost:${PORT}/`);
  console.log(`  Admin UI : http://localhost:${PORT}/admin.html`);
});
