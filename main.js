const tonal = require('tonal');
const fs = require('fs');
const MidiWriter = require('midi-writer-js');
const octave = 4;
const duration = '1'
const sequential = false
const puppeteer = require('puppeteer');
const readline = require('readline');
const { exec } = require('child_process');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question('UフレットのURLを貼り付けてください: ', async (url) => {
  rl.close();

  const browser = await puppeteer.launch({headless: true});
  const page = await browser.newPage();

  // ページが読み込まれるのを待つ
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // (ruby > rt)要素が描画されるのを待つ
  await page.waitForSelector('ruby > rt');

  // 描画された後の処理
  const textContents = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('ruby > rt'));
    return elements.map(element => element.innerText);
  });

  const html = await page.content();
  let defaultBpm = html.match(/const\s+defaultBpm\s*=\s*"([^"]+)";/);
  defaultBpm = defaultBpm[1];
  
  const title = await page.$eval('.show_name', element => element.textContent);

  await browser.close();

  // MIDIファイルを生成する処理
  const track = new MidiWriter.Track();
  track.setTempo(defaultBpm);
  track.addText(textContents.join("        "))

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
  fs.writeFileSync(`midis/${title}.mid`, Buffer.from(midiData, 'binary'));

  // MIDIファイルを保存したフォルダを開く
  exec(`open "${__dirname}/midis"`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error opening folder: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Error: ${stderr}`);
      return;
    }
  });
});

