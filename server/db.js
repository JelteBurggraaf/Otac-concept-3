const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'database.sqlite'));

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sentences (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT    NOT NULL,
    type TEXT    NOT NULL CHECK(type IN ('trainable','nonsense'))
  );

  CREATE TABLE IF NOT EXISTS options (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sentence_id INTEGER NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
    text        TEXT    NOT NULL,
    correct     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bias_stories (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    story_audio    TEXT NOT NULL,
    correct_audio  TEXT NOT NULL,
    wrong_audio    TEXT NOT NULL,
    correct_button TEXT NOT NULL CHECK(correct_button IN ('left','right'))
  );

  CREATE TABLE IF NOT EXISTS pump_words (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    word       TEXT    NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    c1         TEXT NOT NULL,
    c2         TEXT NOT NULL,
    c3         TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    m1_done    INTEGER NOT NULL DEFAULT 0,
    m2_done    INTEGER NOT NULL DEFAULT 0,
    m3_done    INTEGER NOT NULL DEFAULT 0
  );
`);

// Add 'started' column to sessions if it doesn't exist yet (safe migration)
try { db.exec('ALTER TABLE sessions ADD COLUMN started INTEGER NOT NULL DEFAULT 0'); } catch (_) {}

// Seed settings defaults
const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
setDefault.run('active_video', 'Collectieve-kunst.webm');
setDefault.run('reset_token', '0');
setDefault.run('bias_start_audio', '');
setDefault.run('bias_final_audio', '');
setDefault.run('bias_middle_correct_audio', '');
setDefault.run('bias_wrong_audio', '');
setDefault.run('bias_second_wrong_audio', '');
setDefault.run('bias_reset_token', '0');
setDefault.run('bias_sensor_min', '0');
setDefault.run('bias_sensor_max', '1023');
setDefault.run('pump_required',      '8');
setDefault.run('pump_word_duration', '3000');
setDefault.run('dial_sensitivity',   '0.5');
setDefault.run('quiz_sensitivity',   '360');
setDefault.run('exam_url',           '');
setDefault.run('current_qr_session', '0');
setDefault.run('module1_count', '0');
setDefault.run('module2_count', '0');
setDefault.run('module3_count', '0');
for (let d = 0; d <= 9; d++) setDefault.run(`digit_${d}_audio`, '');

// Seed only if empty
const count = db.prepare('SELECT COUNT(*) as n FROM sentences').get().n;
if (count === 0) {
  const insertSentence = db.prepare('INSERT INTO sentences (text, type) VALUES (?, ?)');
  const insertOption   = db.prepare('INSERT INTO options (sentence_id, text, correct) VALUES (?, ?, ?)');

  const seed = db.transaction(() => {
    const trainable = [
      { text: 'Een schilder werkt met ___',         options: [['verf',true],['klei',false],['inkt',false],['gips',false]] },
      { text: 'Water kook je op ___ graden',         options: [['100',true],['80',false],['90',false],['120',false]] },
      { text: 'De zon gaat onder in het ___',         options: [['westen',true],['oosten',false],['noorden',false],['zuiden',false]] },
      { text: 'Een foto maak je met een ___',         options: [['camera',true],['projector',false],['telescoop',false],['penseel',false]] },
      { text: 'Muziek speel je op een ___',           options: [['instrument',true],['microfoon',false],['podium',false],['versterker',false]] },
      { text: 'In een museum hang je ___',            options: [['kunst',true],['gordijnen',false],['spiegels',false],['prijslijsten',false]] },
      { text: 'Mensen verbinden via ___',             options: [['taal',true],['wetten',false],['wegen',false],['geld',false]] },
      { text: 'Samen maak je een ___',                options: [['kunstwerk',true],['contract',false],['schema',false],['inventaris',false]] },
      { text: 'Je fiets zet je op een ___',           options: [['standaard',true],['leuning',false],['haak',false],['plank',false]] },
      { text: 'Een tentoonstelling open je met ___',  options: [['een speech',true],['een formulier',false],['een kaartje',false],['een factuur',false]] },
    ];

    const nonsense = [
      { text: 'Het blauwe idee slaapt ___',                options: [['zachtjes'],['stevig'],['omgekeerd'],['langzaam']] },
      { text: 'De stilte weegt ___ kilo',                  options: [['3'],['17'],['42'],['0']] },
      { text: 'Gisteren ruikt naar ___',                   options: [['regen'],['blauw'],['morgen'],['vergeten']] },
      { text: 'De kleur drie is ___',                      options: [['rond'],['luid'],['nat'],['zacht']] },
      { text: 'Wanneer een gedachte valt, landt ze op ___',options: [['niets'],['geluid'],['een woord'],['het einde']] },
      { text: 'Het geheugen van water smaakt naar ___',    options: [['zout'],['stilte'],['tijd'],['licht']] },
    ];

    for (const s of trainable) {
      const { lastInsertRowid: sid } = insertSentence.run(s.text, 'trainable');
      for (const [text, correct] of s.options) insertOption.run(sid, text, correct ? 1 : 0);
    }

    for (const s of nonsense) {
      const { lastInsertRowid: sid } = insertSentence.run(s.text, 'nonsense');
      for (const [text] of s.options) insertOption.run(sid, text, 1); // all correct
    }
  });

  seed();
  console.log('Database seeded with initial sentences.');
}

module.exports = db;
