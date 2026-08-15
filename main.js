const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const { Chord } = require('tonal');
const MidiWriter = require('midi-writer-js');

const OCTAVE = 4;
const SEQUENTIAL = false;
const DEFAULT_BPM = 120;
const TICKS_PER_BEAT = 128; // midi-writer-js の分解能（4分音符 = 128 ticks）
const DEFAULT_BEATS = 4; // 拍情報が取れないときは 1 コード = 1 小節とみなす
const OUT_DIR = path.join(__dirname, 'midis');
const UA = 'Mozilla/5.0';

// 「N.C.」「N.C」= コード指定なし。休符として扱う
const NO_CHORD = /^n\.?c\.?$/i;

/**
 * インライン JS の配列リテラルを取り出す。
 * 文字列の中の "]"（"[Dm]" などコード記法）で打ち切らないよう、
 * 文字列状態を追いながら括弧の対応を数える。
 */
function readJsArray(html, name) {
  const decl = html.match(new RegExp(`\\b${name}\\s*=\\s*`));
  if (!decl) return null;

  const start = html.indexOf('[', decl.index);
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** インライン JS の文字列リテラルを取り出す（Number('106') 形式も拾う） */
function readJsString(html, name) {
  const m = html.match(new RegExp(`\\b${name}\\s*=\\s*(?:Number\\()?['"]([^'"]*)['"]`));
  return m ? m[1] : null;
}

function chordsInLine(line) {
  return Array.from(line.matchAll(/\[([^\]]*)\]/g), m => m[1].trim());
}

/**
 * 動画プラスページの chord_change から各コードの拍数を復元する。
 * '0' = コードの切り替わり、'9' = 前のコードを保持。1 文字 = 1 拍。
 */
function beatsFromChordChange(html, chordCount) {
  const m = html.match(/chord_change\s*=\s*'(\d+)'/);
  if (!m) return null;

  const flags = m[1];
  const onsets = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '0') onsets.push(i);
  }
  // 「簡単コード ver.」など、譜面とタイミングの対応がずれる版がある
  if (onsets.length !== chordCount) return null;

  return onsets.map((p, i) => (i + 1 < onsets.length ? onsets[i + 1] : flags.length) - p);
}

// 音楽的にありえるコードの長さ（拍）。beatArr は 1〜2拍のずれを含むので、
// 生の値をそのまま使わずこのグリッドに丸める。
const DUPLE_GRID = [1, 2, 4, 8, 16, 32]; // 4/4 など2拍子系
const TRIPLE_GRID = [1, 3, 6, 12, 24, 48]; // 3/4・6/8 など3拍子系

function snapToGrid(grid, value) {
  return grid.reduce((best, g) => (Math.abs(g - value) < Math.abs(best - value) ? g : best), grid[0]);
}

/**
 * 曲全体の「1コードあたりの拍数」の傾向から、どちらの拍子グリッドが合うかを選ぶ。
 * 2拍子系が多数派なので、3拍子系が明確に合うときだけ切り替える。
 */
function pickGrid(quotients) {
  const cost = grid => quotients.reduce((sum, q) => sum + Math.abs(snapToGrid(grid, q) - q) / q, 0);
  return cost(TRIPLE_GRID) < cost(DUPLE_GRID) * 0.85 ? TRIPLE_GRID : DUPLE_GRID;
}

/**
 * 通常ページの beatArr（行ごとの拍数）から各コードの拍数を割り出す。
 * beatArr は「コードを含む行」と先頭から順に対応し、最終行の分は持たない。
 *
 * beatArr の値自体が正確ではない（12拍の箇所を 10 や 13 と報告する）ため、
 * 行の拍数をコード数で割った値を拍子グリッドに丸める。動画プラス版の正解データが
 * ある10曲で突き合わせた結果、この方式が最も一致した（76% / 平均誤差0.46拍。
 * 丸めなしの均等割りは59%、全コード一律4拍だと35%）。
 */
function beatsFromBeatArr(html, lines) {
  const m = html.match(/beatArr\s*=\s*(\[[^\]]*\])/);
  if (!m) return null;

  let beatArr;
  try {
    beatArr = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(beatArr) || beatArr.length === 0) return null;

  const rows = [];
  let row = 0;
  for (const line of lines) {
    const count = chordsInLine(line).length;
    if (count === 0) continue;
    rows.push({ count, lineBeats: beatArr[row++] });
  }

  const usable = rows.filter(r => Number.isFinite(r.lineBeats) && r.lineBeats > 0);
  if (usable.length === 0) return null;

  const grid = pickGrid(usable.map(r => r.lineBeats / r.count));
  const snapped = rows.map(r =>
    (Number.isFinite(r.lineBeats) && r.lineBeats > 0 ? snapToGrid(grid, r.lineBeats / r.count) : null));

  // beatArr が持たない最終行などは、その曲で最も多い長さで埋める
  const tally = new Map();
  for (const per of snapped) {
    if (per !== null) tally.set(per, (tally.get(per) ?? 0) + 1);
  }
  const fallback = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_BEATS;

  const beats = [];
  rows.forEach((r, i) => {
    const per = snapped[i] ?? fallback;
    for (let k = 0; k < r.count; k++) beats.push(per);
  });
  return { beats, triple: grid === TRIPLE_GRID };
}

/**
 * ページ HTML からコード進行と各コードの拍数を取り出す。
 * どちらの経路もカポ0（実音）の譜面データを指す。
 */
function extractSheet(html) {
  // 通常ページ: 歌詞行に [コード] を埋め込んだ配列が埋まっている
  const lines = readJsArray(html, 'ufret_chord_datas');
  if (lines) {
    const chords = lines.flatMap(chordsInLine).filter(Boolean);
    const fromChange = beatsFromChordChange(html, chords.length);
    if (fromChange) return { chords, beats: fromChange, exact: true, triple: false };

    const estimated = beatsFromBeatArr(html, lines);
    return { chords, beats: estimated?.beats ?? null, exact: false, triple: !!estimated?.triple };
  }

  // 動画プラスページ: 譜面が <rt> として直接書き出されている
  const chords = Array.from(html.matchAll(/<rt>([^<]*)<\/rt>/g), m => m[1].trim())
    .filter(c => c && !/['+]/.test(c)); // JS テンプレート由来の断片を除外
  const beats = beatsFromChordChange(html, chords.length);
  return { chords, beats, exact: beats !== null, triple: false };
}

// ページには tempo_change（"拍位置,BPM" の並び）もあるが、midi-writer-js の
// setTempo(bpm, tick) は tick を無視して全て先頭に置き、最後の値が全曲に効いてしまう。
// 曲全体のテンポを誤らせるため、ここでは単一テンポのみ扱う。

function extractTitle(html) {
  const name = readJsString(html, 'song_name');
  if (name) return name.replace(/\s*\(動画プラス\)\s*$/, '').trim();

  const m = html.match(/<title>([^<]*)<\/title>/);
  if (m) return m[1].split(/\s+ギターコード/)[0].trim();

  return 'untitled';
}

function extractBpm(html) {
  const raw = readJsString(html, 'defaultBpm') ?? readJsString(html, 'song_bpm');
  return Number(raw) || DEFAULT_BPM;
}

/** OS が扱えないファイル名文字を落とす */
function safeFileName(name) {
  const cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .slice(0, 100);
  return cleaned || 'untitled';
}

// 同じコードは曲中で何十回も出るので一度だけ解析する
const pitchCache = new Map();

function chordPitches(chord) {
  const cached = pitchCache.get(chord);
  if (cached) return cached;

  // U フレットは ♭ / ♯ 記号、ハーフディミニッシュを m7-5 と書く。tonal はこれを読めない
  const name = chord
    .replace(/♭/g, 'b')
    .replace(/♯/g, '#')
    .replace(/-5(?!\d)/, 'b5');

  const pitches = Chord.notes(name).map(note => note + OCTAVE);
  pitchCache.set(chord, pitches);
  return pitches;
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`ページを取得できませんでした (HTTP ${res.status})`);
  return res.text();
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

function formatDuration(beats, bpm) {
  const sec = Math.round(beats * 60 / bpm);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

async function main() {
  const url = await ask('UフレットのURLを貼り付けてください: ');
  if (!/^https?:\/\/(www\.)?ufret\.jp\//.test(url)) {
    throw new Error('Uフレットの曲ページ URL を指定してください (例: https://www.ufret.jp/song.php?data=1052)');
  }

  const html = await fetchHtml(url);
  const { chords, beats, exact, triple } = extractSheet(html);
  if (chords.length === 0) {
    throw new Error('コードを取得できませんでした。曲ページの URL か、ページ構成が変わっていないか確認してください。');
  }

  const title = extractTitle(html);
  const bpm = extractBpm(html);
  const beatsPerChord = chords.map((_, i) => beats?.[i] ?? DEFAULT_BEATS);
  const totalBeats = beatsPerChord.reduce((a, b) => a + b, 0);

  const source = beats
    ? (exact ? '正確（動画プラスのタイミングデータ）' : `推定（行ごとの拍数から復元 / ${triple ? '3拍子系' : '2拍子系'}）`)
    : 'なし（全コード1小節）';
  console.log(`タイトル: ${title}`);
  console.log(`BPM: ${bpm}`);
  console.log(`コード数: ${chords.length}`);
  console.log(`音の長さ: ${source}`);
  console.log(`総尺: ${totalBeats}拍 ≒ ${formatDuration(totalBeats, bpm)}`);

  const track = new MidiWriter.Track();
  track.setTempo(bpm);
  track.addText(chords.join('        '));

  const events = [];
  const unresolved = new Map();
  let restBeats = 0; // 直前に置くべき休符の長さ（拍）

  for (let i = 0; i < chords.length; i++) {
    const chord = chords[i];
    const chordBeats = beatsPerChord[i];

    if (NO_CHORD.test(chord)) {
      restBeats += chordBeats;
      continue;
    }

    const pitch = chordPitches(chord);
    if (pitch.length === 0) {
      unresolved.set(chord, (unresolved.get(chord) ?? 0) + 1);
      restBeats += chordBeats;
      continue;
    }

    events.push(new MidiWriter.NoteEvent({
      pitch,
      duration: `T${chordBeats * TICKS_PER_BEAT}`,
      sequential: SEQUENTIAL,
      // 休符ぶんだけ待って、進行の位置がずれないようにする
      ...(restBeats > 0 && { wait: `T${restBeats * TICKS_PER_BEAT}` }),
    }));
    restBeats = 0;
  }

  const used = [...pitchCache].filter(([, p]) => p.length > 0).map(([c]) => c);
  console.log(`使用コード: ${used.join(' ')}`);
  if (unresolved.size > 0) {
    const list = [...unresolved].map(([c, n]) => `${c}(${n}回)`).join(' ');
    console.log(`解析できず休符にしたコード: ${list}`);
  }

  track.addEvent(events);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${safeFileName(title)}.mid`);
  fs.writeFileSync(file, Buffer.from(new MidiWriter.Writer(track).buildFile(), 'binary'));
  console.log(`保存しました: ${file}`);

  execFile('open', [OUT_DIR], error => {
    if (error) console.error(`フォルダを開けませんでした: ${error.message}`);
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error(`エラー: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  extractSheet,
  extractTitle,
  extractBpm,
  chordPitches,
  safeFileName,
  fetchHtml,
};
