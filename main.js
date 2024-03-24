const tonal = require('tonal');
const fs = require('fs');
const MidiWriter = require('midi-writer-js');
const octave = 4;
const duration = '1'
const sequential = false
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({headless: false});
  const page = await browser.newPage();

  // ページが読み込まれるのを待つ
  await page.goto('https://www.ufret.jp/song.php?data=3110', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // (ruby > rt)要素が描画されるのを待つ
  await page.waitForSelector('ruby > rt');

  // 描画された後の処理
  const textContents = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('ruby > rt'));
    return elements.map(element => element.innerText);
  });

  await browser.close();

  // MIDIファイルを生成する処理
  const track = new MidiWriter.Track();

  textContents.forEach(chord => {
    let note = tonal.Chord.notes(chord)
    note = note.map(note => note + octave)

    noteEvent = new MidiWriter.NoteEvent({pitch: note, duration: duration, sequential: sequential});
    track.addEvent([noteEvent])
  });

  // MIDIファイルを作成
  const write = new MidiWriter.Writer(track);
  const midiData = write.buildFile();
  // MIDIファイルを保存
  fs.writeFileSync('Chord.mid', Buffer.from(midiData, 'binary'));
})();
