/**
 * 音の長さの推定精度を自分で確かめるための検証スクリプト。
 *
 *   node verify.js                 10ペアで推定精度を測る
 *   node verify.js midis/曲名.mid  生成済み MIDI を解析して各コードの長さを表示
 *   node verify.js --find-pairs    検証に使えるペアを探し直す（158リクエスト）
 *
 * 仕組み: U フレットには「通常版」と「動画プラス版」が両方ある曲がある。
 * 動画プラス版は chord_change に1拍ずつのコード切替が入っていて長さが正確に分かる。
 * 通常版は beatArr（行ごとの拍数）しか無いので推定になる。
 * 同じ曲でコード列が完全一致するペアを見つければ、プラス版を正解として
 * 通常版の推定がどれだけ当たっているかを測れる。
 */

const fs = require('fs');
const { extractSheet, extractTitle, extractBpm, fetchHtml } = require('./main.js');

const SONG_URL = id => `https://www.ufret.jp/song.php?data=${id}`;

// [動画プラス版ID(正解), 通常版ID(推定)]。--find-pairs で見つけたもの
const PAIRS = [
  [48975, 48036], [48738, 44369], [49470, 41], [73124, 73009], [58700, 58620],
  [200429, 156112], [49341, 1144], [155118, 155014], [48942, 1041], [60237, 14030],
];

const pad = (s, n) => String(s).slice(0, n).padEnd(n);
const mmss = (beats, bpm) => {
  const s = Math.round(beats * 60 / bpm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** 同時に投げるリクエスト数を絞る */
async function pool(items, limit, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  }));
  return out;
}

async function checkAccuracy() {
  console.log('通常版の推定を、動画プラス版の正確なデータと突き合わせます\n');
  console.log(`${pad('曲', 30)} 拍子   一致率  平均誤差  推定尺 / 正解尺`);
  console.log('-'.repeat(72));

  let hit = 0, total = 0, errSum = 0;

  for (const [plusId, normalId] of PAIRS) {
    const [plusHtml, normalHtml] = await Promise.all([fetchHtml(SONG_URL(plusId)), fetchHtml(SONG_URL(normalId))]);
    const truth = extractSheet(plusHtml);
    const guess = extractSheet(normalHtml);

    if (!truth.exact || !guess.beats) {
      console.log(`${pad(extractTitle(normalHtml), 30)} 比較できません（データ構成が変わった可能性）`);
      continue;
    }
    if (JSON.stringify(truth.chords) !== JSON.stringify(guess.chords)) {
      console.log(`${pad(extractTitle(normalHtml), 30)} コード列が一致しないため除外`);
      continue;
    }

    const n = Math.min(truth.beats.length, guess.beats.length);
    let exact = 0, err = 0;
    for (let i = 0; i < n; i++) {
      if (guess.beats[i] === truth.beats[i]) exact++;
      err += Math.abs(guess.beats[i] - truth.beats[i]);
    }
    hit += exact; total += n; errSum += err;

    const bpm = extractBpm(normalHtml);
    const sum = a => a.reduce((x, y) => x + y, 0);
    console.log(
      `${pad(extractTitle(normalHtml), 30)} ${guess.triple ? '3拍子' : '2拍子'}  `
      + `${String(Math.round(exact / n * 100)).padStart(3)}%   ${(err / n).toFixed(2)}拍   `
      + `${mmss(sum(guess.beats), bpm)} / ${mmss(sum(truth.beats), bpm)}`
    );
  }

  console.log('-'.repeat(72));
  console.log(`合計: ${hit}/${total} コードが完全一致 (${Math.round(hit / total * 100)}%), 平均誤差 ${(errSum / total).toFixed(2)}拍`);
  console.log('参考: 長さを推定せず全コード4拍にすると 35% / 1.57拍でした');
}

/** MIDI を読んで、実際に書き込まれた各コードの長さ（拍）を復元する */
function dumpMidi(file) {
  const b = fs.readFileSync(file);
  const readVar = p => { let v = 0, byte; do { byte = b[p++]; v = (v << 7) | (byte & 0x7f); } while (byte & 0x80); return [v, p]; };

  const division = b.readUInt16BE(12); // 4分音符あたりの tick
  let p = 22; // ヘッダ14 + MTrkヘッダ8
  const end = 22 + b.readUInt32BE(18);
  let tick = 0, running = 0, lastOff = 0;
  const onsets = [], tempos = [];

  while (p < end) {
    let delta; [delta, p] = readVar(p);
    tick += delta;
    let status = b[p];
    if (status & 0x80) { p++; running = status; } else { status = running; }

    if (status === 0xff) {
      const type = b[p++];
      let len; [len, p] = readVar(p);
      if (type === 0x51) tempos.push(Math.round(60000000 / ((b[p] << 16) | (b[p + 1] << 8) | b[p + 2])));
      p += len;
      running = 0;
    } else if ((status & 0xf0) === 0x90) {
      if (b[p + 1] > 0) onsets.push(tick); else lastOff = tick;
      p += 2;
    } else if ((status & 0xf0) === 0x80) { lastOff = tick; p += 2; }
    else if ((status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0) p += 1;
    else p += 2;
  }

  const starts = [...new Set(onsets)].sort((x, y) => x - y);
  // 各コードの長さ = 次のコードの開始まで。最後のコードは終端（最後のノートオフ）まで
  const boundaries = [...starts, lastOff];
  const beats = boundaries.slice(1).map((t, i) => (t - boundaries[i]) / division);
  const dist = {};
  beats.forEach(x => { dist[x] = (dist[x] ?? 0) + 1; });

  console.log(`ファイル: ${file}`);
  console.log(`テンポ: ${tempos.join(', ')} BPM`);
  console.log(`コード数: ${starts.length}（同時に鳴るノート ${onsets.length} 個をまとめた数）`);
  console.log(`開始位置: ${starts[0]} tick（0 なら曲頭から始まっている）`);
  console.log(`総尺: ${lastOff / division} 拍`);
  console.log(`長さの内訳（拍:個数）: ${JSON.stringify(dist)}`);
  console.log(`先頭20コードの長さ: ${beats.slice(0, 20).join(', ')}`);
}

/** 検証に使えるペア（通常版とプラス版でコード列が一致する曲）を探す */
async function findPairs() {
  console.log('U フレットのトップページから曲を集めて分類します（158件ほど取得します）\n');
  const top = await fetchHtml('https://www.ufret.jp/');
  const ids = [...new Set([...top.matchAll(/song\.php\?data=(\d+)/g)].map(m => m[1]))];
  console.log(`候補 ${ids.length} 曲を取得中...`);

  const songs = (await pool(ids, 6, async id => {
    const html = await fetchHtml(SONG_URL(id));
    const sheet = extractSheet(html);
    return sheet.chords.length ? { id, title: extractTitle(html), ...sheet } : null;
  })).filter(Boolean);

  const byChords = new Map();
  songs.filter(s => !s.exact && s.beats).forEach(s => {
    const k = JSON.stringify(s.chords);
    if (!byChords.has(k)) byChords.set(k, []);
    byChords.get(k).push(s);
  });

  const pairs = [];
  for (const plus of songs.filter(s => s.exact)) {
    for (const normal of byChords.get(JSON.stringify(plus.chords)) ?? []) {
      pairs.push([Number(plus.id), Number(normal.id)]);
      console.log(`プラス ${plus.id} ⇔ 通常 ${normal.id}  ${normal.title}（コード${plus.chords.length}個）`);
    }
  }
  console.log(`\n${songs.length}曲中 ${pairs.length}ペア。verify.js の PAIRS を差し替えると検証対象を増やせます:`);
  console.log(JSON.stringify(pairs));
}

const arg = process.argv[2];
const run = arg === '--find-pairs' ? findPairs()
  : arg ? Promise.resolve(dumpMidi(arg))
    : checkAccuracy();

Promise.resolve(run).catch(e => {
  console.error(`エラー: ${e.message}`);
  process.exitCode = 1;
});
