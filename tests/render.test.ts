import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computeSpeechCost } from "../src/lib/media/cost";
import { maxBytesFor, pcmFormatFromMime, pcmToWav, sniffMedia } from "../src/lib/media/files";
import { fontFamilyName } from "../src/lib/media/font";
import {
  MAX_RENDER_CLIPS,
  assEscape,
  buildAss,
  buildCaptions,
  buildRenderPlan,
  buildTimeline,
  captionChars,
  frameFor,
  frameForShape,
  inputFormat,
  parseProbe,
  splitCaptionText,
  wavDurationSeconds,
  type RenderClip,
  type RenderNarration,
} from "../src/lib/media/render-plan";

const video = (file: string, seconds: number, hasAudio = false): RenderClip => ({ file, type: "video", durationSeconds: seconds, hasAudio });
const still = (file: string): RenderClip => ({ file, type: "image", durationSeconds: 0, hasAudio: false });
const voice = (file: string, seconds: number, text = "Words."): RenderNarration => ({ file, durationSeconds: seconds, text });
const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

// ─── Timeline ────────────────────────────────────────────────────────────────

test("clips follow each other; a still is shown for its set time", () => {
  const t = buildTimeline({ clips: [video("a.mp4", 3), still("b.png"), video("c.mp4", 2.5)], narration: [], stillSeconds: 4 });
  assert.deepEqual(t.segments, [
    { start: 0, duration: 3, frames: 90, hold: 0 },
    { start: 3, duration: 4, frames: 120, hold: 0 },
    { start: 7, duration: 2.5, frames: 75, hold: 0 },
  ]);
  assert.equal(t.totalSeconds, 9.5);
  assert.equal(t.totalFrames, 285);
  assert.deepEqual(t.narration, []);
});

test("every clip lasts a whole number of frames, and starts where the frames before it end", () => {
  // Files often say they are a little longer than their picture is: 2.02 s
  // for 2 s of video with sound that runs on. 2.02 s is 60.6 frames.
  const t = buildTimeline({ clips: [video("a.mp4", 2.02), video("b.mp4", 2.02), video("c.mp4", 2.02)], narration: [] });
  assert.deepEqual(t.segments.map((s) => s.frames), [61, 61, 61]);
  assert.deepEqual(t.segments.map((s) => s.start), [0, 2.033, 4.067]);
  // The starts and the total come from the count of frames, not from adding
  // rounded seconds up: 183 frames are 6.1 seconds, not 3 × 2.033 = 6.099.
  assert.equal(t.totalFrames, 183);
  assert.equal(t.totalSeconds, 6.1);
  // A voice-over starts with its clip's first frame, plus the pause before it.
  const paired = buildTimeline({
    clips: [video("a.mp4", 2.02), video("b.mp4", 2.02)],
    narration: [voice("1.wav", 1), voice("2.wav", 1)],
  });
  assert.deepEqual(paired.narration.map((n) => n.start), [0.15, 2.183]);
  // Never less than a frame.
  assert.equal(buildTimeline({ clips: [video("a.mp4", 0)], narration: [] }).segments[0]!.frames, 3);
});

test("one voice-over per clip: each starts with its clip, and a shorter clip holds its last frame", () => {
  const t = buildTimeline({
    clips: [video("a.mp4", 3), video("b.mp4", 5), still("c.png")],
    narration: [voice("1.wav", 4.2), voice("2.wav", 1), voice("3.wav", 6)],
  });
  // 0.15 s before the voice and 0.35 s after it.
  assert.deepEqual(t.segments, [
    { start: 0, duration: 4.7, frames: 141, hold: 1.7 },
    { start: 4.7, duration: 5, frames: 150, hold: 0 },
    { start: 9.7, duration: 6.5, frames: 195, hold: 2.5 },
  ]);
  assert.deepEqual(t.narration.map((n) => n.start), [0.15, 4.85, 9.85]);
  assert.equal(t.totalSeconds, 16.2);
});

test("any other number of voice-overs: they follow each other, and the last clip holds until they end", () => {
  const t = buildTimeline({ clips: [video("a.mp4", 2), video("b.mp4", 2)], narration: [voice("1.wav", 3), voice("2.wav", 2.5), voice("3.wav", 1)] });
  // 0.15 + 3 + 0.25 + 2.5 + 0.25 + 1 + 0.35 = 7.5 seconds of speaking over 4 seconds of video.
  assert.deepEqual(t.segments, [
    { start: 0, duration: 2, frames: 60, hold: 0 },
    { start: 2, duration: 5.5, frames: 165, hold: 3.5 },
  ]);
  assert.deepEqual(t.narration.map((n) => [n.start, n.duration]), [[0.15, 3], [3.4, 2.5], [6.15, 1]]);
  assert.equal(t.totalSeconds, 7.5);
  // A voice-over shorter than the video changes nothing.
  assert.equal(buildTimeline({ clips: [video("a.mp4", 8), video("b.mp4", 2)], narration: [voice("1.wav", 3)] }).totalSeconds, 10);
});

// ─── Subtitles ───────────────────────────────────────────────────────────────

test("what is said is cut into pieces that can be read at once", () => {
  assert.deepEqual(splitCaptionText("Pekanbaru wakes early. The first coffee is brewed before sunrise!", 34), [
    "Pekanbaru wakes early.",
    "The first coffee is brewed before",
    "sunrise!",
  ]);
  // At a comma when one is far enough in, else between words.
  assert.deepEqual(splitCaptionText("Try it yourself, then tell us how it went for you", 30), ["Try it yourself,", "then tell us how it went for", "you"]);
  // A word longer than a line is cut where the line ends.
  assert.deepEqual(splitCaptionText("x".repeat(25), 10), ["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"]);
  assert.deepEqual(splitCaptionText("  \n ", 30), []);
  assert.deepEqual(splitCaptionText("One.   Two.\nThree.", 30), ["One.", "Two.", "Three."]);
});

test("the pieces share the voice-over's time by their length", () => {
  const captions = buildCaptions([{ start: 1, duration: 4, text: "Short. A much longer second sentence here." }], 40);
  assert.equal(captions.length, 2);
  assert.deepEqual([captions[0]!.start, captions[1]!.end], [1, 5]);
  assert.equal(captions[0]!.end, captions[1]!.start);
  assert.ok(captions[1]!.end - captions[1]!.start > captions[0]!.end - captions[0]!.start);
  // Nothing to show for a voice-over without text or without length.
  assert.deepEqual(buildCaptions([{ start: 0, duration: 2, text: " " }, { start: 2, duration: 0, text: "Hi" }], 40), []);
});

test("subtitle text cannot carry commands of the subtitle format", () => {
  assert.equal(assEscape("Hello {\\an8}world\\N{\\fs200}!"), "Hello (/an8)world/N(/fs200)!");
  assert.equal(assEscape("Line one\nline two\r\nline three"), "Line one line two line three");
  const ass = buildAss(
    [
      { start: 0.15, end: 2.4, text: "First {\\b1}line" },
      { start: 3661.5, end: 3662, text: "Later" },
    ],
    { width: 1080, height: 1920, fontName: "Noto Sans,Bold\nStyle: Evil" },
  );
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  // The font name is one field of the style line, whatever it contains.
  assert.equal(ass.split("\n").filter((line) => line.startsWith("Style:")).length, 1);
  assert.match(ass, /Style: Default,Noto Sans Bold Style: Evil,\d+,/);
  assert.match(ass, /Dialogue: 0,0:00:00\.15,0:00:02\.40,Default,,0,0,0,,First \(\/b1\)line/);
  assert.match(ass, /Dialogue: 0,1:01:01\.50,1:01:02\.00,Default,,0,0,0,,Later/);
});

test("fewer characters fit a line of a vertical video", () => {
  assert.ok(captionChars(1080, 1920) < captionChars(1080, 1080));
  assert.ok(captionChars(1080, 1080) < captionChars(1920, 1080));
});

// ─── Frame ───────────────────────────────────────────────────────────────────

test("the frame is 1080 on its short side, with even numbers", () => {
  assert.deepEqual(frameFor("9:16"), { width: 1080, height: 1920 });
  assert.deepEqual(frameFor("16:9"), { width: 1920, height: 1080 });
  assert.deepEqual(frameFor("1:1"), { width: 1080, height: 1080 });
  assert.deepEqual(frameFor("4:5"), { width: 1080, height: 1350 });
  assert.deepEqual(frameFor("3:4"), { width: 1080, height: 1440 });
  assert.deepEqual(frameFor(undefined), { width: 1080, height: 1920 });
  assert.deepEqual(frameFor("wide"), { width: 1080, height: 1920 });
  assert.deepEqual(frameForShape(720, 1280), { width: 1080, height: 1920 });
  assert.deepEqual(frameForShape(1281, 721), { width: 1918, height: 1080 });
  // Very long shapes stop at 4K.
  assert.deepEqual(frameForShape(10, 1), { width: 3840, height: 1080 });
  assert.deepEqual(frameForShape(0, 0), { width: 1080, height: 1920 });
});

// ─── The ffmpeg command ──────────────────────────────────────────────────────

test("every input is a local file read as what it is, never guessed", () => {
  const plan = buildRenderPlan({ clips: [video("/m/a.mp4", 3), still("/m/b.png"), video("/m/c.webm", 2)], narration: [], width: 1080, height: 1920, output: "/m/.out.part" });
  const args = plan.args.join(" ");
  assert.equal(plan.args.filter((a) => a === "-protocol_whitelist").length, 3);
  assert.match(args, /-protocol_whitelist file -f mov -i \/m\/a\.mp4/);
  // A still is one frame repeated for its time, and its name is never a pattern.
  assert.match(args, /-protocol_whitelist file -loop 1 -framerate 30 -t 4\.000 -f image2 -pattern_type none -i \/m\/b\.png/);
  assert.match(args, /-protocol_whitelist file -f matroska -i \/m\/c\.webm/);
  assert.match(args, /-c:v libx264 .*-pix_fmt yuv420p .*-t 9\.000 -movflags \+faststart -f mp4 \/m\/\.out\.part$/);
  assert.equal(plan.hasAudio, false);
  assert.ok(!args.includes("-map [aout]"));
  assert.equal(plan.args[0], "-hide_banner");
  assert.ok(plan.args.includes("-nostdin"));
});

test("clips are scaled into the frame, whole or filling it, and held when a voice-over is longer", () => {
  const contain = buildRenderPlan({ clips: [video("a.mp4", 2)], narration: [voice("n.wav", 3)], width: 1080, height: 1920, output: "o" });
  const graph = contain.args[contain.args.indexOf("-filter_complex") + 1]!;
  // 3.5 seconds are 105 frames: the last frame is repeated, and the clip is cut after exactly that many.
  assert.match(graph, /\[0:v:0\]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black,setsar=1,fps=30,format=yuv420p,tpad=stop_mode=clone:stop_duration=3\.500,trim=end_frame=105,setpts=PTS-STARTPTS\[v0\]/);
  assert.match(graph, /\[v0\]concat=n=1:v=1:a=0\[vcat\]/);
  // The voice-over starts a moment in, and the sound is as long as the picture: 105 frames of 1600 samples.
  assert.match(graph, /\[1:a:0\]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=150\|150\[n0\]/);
  assert.match(graph, /\[n0\]apad,atrim=end_sample=168000\[aout\]/);
  assert.equal(contain.hasAudio, true);
  assert.ok(contain.args.join(" ").includes("-map [vcat] -map [aout]"));

  const cover = buildRenderPlan({ clips: [video("a.mp4", 2)], narration: [], width: 1080, height: 1080, fit: "cover", output: "o" });
  assert.match(cover.args[cover.args.indexOf("-filter_complex") + 1]!, /scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080/);
});

test("subtitles are drawn from a file in ffmpeg's own folder, only when there is something to show", () => {
  const base = { clips: [video("a.mp4", 4)], width: 1080, height: 1920, output: "o", subtitles: true, subtitleFile: "subs.ass", fontsDir: "fonts" };
  const withText = buildRenderPlan({ ...base, narration: [voice("n.wav", 2, "Hello there.")] });
  const graph = withText.args[withText.args.indexOf("-filter_complex") + 1]!;
  assert.match(graph, /\[vcat\]ass=subs\.ass:fontsdir=fonts\[vsub\]/);
  assert.ok(withText.args.join(" ").includes("-map [vsub]"));
  assert.deepEqual(withText.captions.map((c) => c.text), ["Hello there."]);
  const silent = buildRenderPlan({ ...base, narration: [] });
  assert.ok(!silent.args.join(" ").includes("ass="));
  assert.deepEqual(silent.captions, []);
});

test("the clips' own sound is kept when asked, quieter under a voice-over, with silence where a clip has none", () => {
  const clips = [video("a.mp4", 2, true), still("b.png"), video("c.mp4", 3, false)];
  const kept = buildRenderPlan({ clips, narration: [], width: 1080, height: 1920, keepClipAudio: true, stillSeconds: 2, output: "o" });
  const graph = kept.args[kept.args.indexOf("-filter_complex") + 1]!;
  assert.match(graph, /\[0:a:0\]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=96000,asetpts=PTS-STARTPTS\[a0\]/);
  assert.match(graph, /anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end_sample=96000,asetpts=PTS-STARTPTS\[a1\]/);
  assert.match(graph, /\[a0\]\[a1\]\[a2\]concat=n=3:v=0:a=1\[clips\]/);
  assert.match(graph, /\[clips\]apad,atrim=end_sample=336000\[aout\]/);

  const under = buildRenderPlan({ clips, narration: [voice("n.wav", 1)], width: 1080, height: 1920, keepClipAudio: true, stillSeconds: 2, output: "o" });
  const mixed = under.args[under.args.indexOf("-filter_complex") + 1]!;
  assert.match(mixed, /concat=n=3:v=0:a=1,volume=0\.25\[clips\]/);
  // Mixed at full level in a way that every ffmpeg from 4.2 on understands:
  // both as long as the video, mixed (which halves them), and doubled again.
  assert.match(mixed, /\[clips\]apad,atrim=end_sample=336000\[m0\];\[n0\]apad,atrim=end_sample=336000\[m1\];\[m0\]\[m1\]amix=inputs=2:duration=first,volume=2\[aout\]/);
  assert.ok(!/normalize=|all=1/.test(mixed), "options that older ffmpeg versions do not have");

  // Not asked for, or no clip has sound: no sound track of the clips.
  const dropped = buildRenderPlan({ clips, narration: [], width: 1080, height: 1920, stillSeconds: 2, output: "o" });
  assert.equal(dropped.hasAudio, false);
  const none = buildRenderPlan({ clips: [video("x.mp4", 1, false)], narration: [], width: 1080, height: 1920, keepClipAudio: true, output: "o" });
  assert.equal(none.hasAudio, false);
});

test("what cannot be joined is refused", () => {
  const frame = { width: 1080, height: 1920, output: "o", narration: [] };
  assert.throws(() => buildRenderPlan({ ...frame, clips: [] }), /at least one clip/);
  assert.throws(() => buildRenderPlan({ ...frame, clips: Array.from({ length: MAX_RENDER_CLIPS + 1 }, () => video("a.mp4", 1)) }), /Too many clips/);
  assert.throws(() => buildRenderPlan({ ...frame, clips: [video("a.mp4", 16 * 60)] }), /longer than 15 minutes/);
  assert.throws(() => buildRenderPlan({ ...frame, clips: [video("playlist.m3u8", 5)] }), /Unsupported input file/);
  assert.equal(inputFormat("/m/x.MP4"), "mov");
  assert.equal(inputFormat("x.jpg"), "image2");
  assert.equal(inputFormat("x.gif"), "gif");
  assert.equal(inputFormat("x.m3u8"), null);
  assert.equal(inputFormat("x.txt"), null);
});

// ─── Reading what ffmpeg says about a file ───────────────────────────────────

test("the length, the frame and the streams are read from ffmpeg's description of a file", () => {
  const info = parseProbe(
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':\n" +
      "  Duration: 00:01:03.04, start: 0.000000, bitrate: 172 kb/s\n" +
      "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 720x1280 [SAR 1:1 DAR 9:16], 42 kb/s, 24 fps\n" +
      "  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s\n" +
      "At least one output file must be specified\n",
  );
  assert.deepEqual(info, { durationSeconds: 63.04, width: 720, height: 1280, hasVideo: true, hasAudio: true });
  const image = parseProbe("Input #0, png_pipe, from 'c.png':\n  Duration: N/A, bitrate: N/A\n  Stream #0:0: Video: png, rgb24(pc), 800x800, 25 fps\n");
  assert.deepEqual(image, { durationSeconds: null, width: 800, height: 800, hasVideo: true, hasAudio: false });
  // The cover picture inside a music file is not a video.
  const music = parseProbe("  Duration: 00:00:04.20, start: 0.0\n  Stream #0:0: Audio: mp3, 44100 Hz\n  Stream #0:1: Video: mjpeg, yuvj420p, 600x600 (attached pic)\n");
  assert.deepEqual([music.hasAudio, music.hasVideo, music.durationSeconds], [true, false, 4.2]);
  assert.deepEqual(parseProbe("a.txt: Invalid data found when processing input"), { durationSeconds: null, width: null, height: null, hasVideo: false, hasAudio: false });
});

// ─── Audio files ─────────────────────────────────────────────────────────────

test("bare samples get a WAV header, and the length of a WAV file is read from it", () => {
  const pcm = new Uint8Array(24_000 * 2); // one second, 16-bit mono at 24 kHz
  const wav = pcmToWav(pcm, { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
  assert.equal(wav.byteLength, 44 + pcm.byteLength);
  assert.deepEqual(sniffMedia(wav.subarray(0, 16)), { kind: "audio", mime: "audio/wav", ext: "wav" });
  assert.equal(wavDurationSeconds(wav), 1);
  const stereo = pcmToWav(new Uint8Array(48_000 * 4 * 3), { sampleRate: 48_000, channels: 2, bitsPerSample: 16 });
  assert.equal(wavDurationSeconds(stereo), 3);
  assert.equal(wavDurationSeconds(new Uint8Array(10)), null);
  assert.equal(wavDurationSeconds(bytes("RIFF", [0, 0, 0, 0], "AVI ", new Array(40).fill(0))), null);
  // A streamed file that declares more data than it has: what is there counts.
  const truncated = wav.slice(0, 44 + 24_000);
  assert.equal(wavDurationSeconds(truncated), 0.5);
});

test("the format of bare samples is read from the type they come with", () => {
  assert.deepEqual(pcmFormatFromMime("audio/L16;codec=pcm;rate=24000"), { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
  assert.deepEqual(pcmFormatFromMime("audio/pcm;rate=16000;channels=2"), { sampleRate: 16_000, channels: 2, bitsPerSample: 16 });
  assert.deepEqual(pcmFormatFromMime("audio/L24"), { sampleRate: 24_000, channels: 1, bitsPerSample: 24 });
  assert.equal(pcmFormatFromMime("audio/mpeg"), null);
  assert.equal(pcmFormatFromMime("audio/wav"), null);
  assert.equal(pcmFormatFromMime(null), null);
});

test("audio files are recognised by their first bytes", () => {
  const kind = (b: Uint8Array) => sniffMedia(b)?.ext ?? null;
  assert.equal(kind(bytes("ID3", [3, 0, 0, 0, 0, 0, 0])), "mp3");
  assert.equal(kind(bytes([0xff, 0xfb, 0x90, 0x00])), "mp3"); // MPEG audio, layer III, no tag
  assert.equal(kind(bytes([0xff, 0xf1, 0x50, 0x80])), "aac"); // ADTS
  assert.equal(kind(bytes("OggS", [0, 2, 0, 0])), "ogg");
  assert.equal(kind(bytes("fLaC", [0, 0, 0, 34])), "flac");
  assert.equal(kind(bytes([0, 0, 0, 0x20], "ftypM4A ")), "m4a");
  assert.equal(kind(bytes("RIFF", [0, 0, 0, 0], "WAVEfmt ")), "wav");
  // A video container is still a video, and text is nothing.
  assert.equal(sniffMedia(bytes([0, 0, 0, 0x18], "ftypisom"))?.kind, "video");
  assert.equal(kind(bytes('{"error":"quota"}')), null);
  assert.equal(kind(bytes("<html>")), null);
  assert.ok(maxBytesFor("audio") < maxBytesFor("video"));
  assert.ok(maxBytesFor("image") < maxBytesFor("audio"));
});

test("speech is priced by the length of the text", () => {
  assert.equal(computeSpeechCost({ pricePerMChars: 15 }, 1_000_000), 15);
  assert.equal(computeSpeechCost({ pricePerMChars: 15 }, 200), 0.003);
  assert.equal(computeSpeechCost({ pricePerMChars: null }, 200), null);
  assert.equal(computeSpeechCost({ pricePerMChars: 15 }, 0), null);
});

// ─── The subtitle font ───────────────────────────────────────────────────────

test("the bundled font's family name is read from the file, as the subtitle renderer needs it", () => {
  const font = readFileSync(join(process.cwd(), "assets", "fonts", "NotoSans-Bold.ttf"));
  assert.equal(fontFamilyName(font), "Noto Sans");
  assert.equal(fontFamilyName(new Uint8Array(64)), null);
  assert.equal(fontFamilyName(new Uint8Array([1, 2, 3])), null);
  // A file cut off in the middle is not read past its end.
  assert.equal(fontFamilyName(font.subarray(0, 200)), null);
});
