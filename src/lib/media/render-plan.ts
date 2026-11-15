/**
 * Joining clips into one video with ffmpeg: the timeline, the subtitles and
 * the command line. Pure: it builds text and argument lists and runs nothing,
 * so the rules can be unit-tested without ffmpeg.
 *
 * The result is one MP4 (H.264 + AAC). Every clip is scaled into the same
 * frame, clips follow each other without a transition, a voice-over is laid
 * over them, and its text can be burned in as subtitles.
 *
 *   voice-over files = clips    each voice-over starts with its clip, and a
 *                               clip that is shorter than its voice-over holds
 *                               its last frame until the voice-over ends
 *   any other number            the voice-overs follow each other from the
 *                               start, and the last clip holds its last frame
 *                               until they end
 */

export const MAX_RENDER_CLIPS = 40;
export const MAX_RENDER_SECONDS = 15 * 60;
/** How long a still image is shown when no voice-over decides it. */
export const DEFAULT_STILL_SECONDS = 4;
export const MAX_STILL_SECONDS = 60;
export const RENDER_FPS = 30;
/** Samples of sound a second in the result, and so in one frame of it. */
const AUDIO_RATE = 48_000;
const SAMPLES_PER_FRAME = AUDIO_RATE / RENDER_FPS;

/** Silence before a voice-over starts in its clip, and after it ends. */
const LEAD_IN = 0.15;
const TAIL = 0.35;
/** Pause between two voice-overs that follow each other. */
const GAP = 0.25;

export interface RenderClip {
  /** The input file, as given to ffmpeg. */
  file: string;
  type: "video" | "image";
  /** Length of a video. Ignored for an image. */
  durationSeconds: number;
  hasAudio: boolean;
}

export interface RenderNarration {
  file: string;
  durationSeconds: number;
  /** What is said, for the subtitles. */
  text: string;
}

export type RenderFit = "contain" | "cover";

export interface RenderSpec {
  clips: RenderClip[];
  narration: RenderNarration[];
  width: number;
  height: number;
  fit?: RenderFit;
  /** Seconds a still image is shown. */
  stillSeconds?: number;
  /** Keep the sound the clips came with. Under a voice-over it is turned down. */
  keepClipAudio?: boolean;
  /** Burn the voice-over text in. Needs `subtitleFile`. */
  subtitles?: boolean;
  /** Name of the subtitle file and of the font folder, relative to ffmpeg's working folder. */
  subtitleFile?: string;
  fontsDir?: string;
  output: string;
}

export interface TimelineSegment {
  start: number;
  /** Shown for this long: a whole number of frames. */
  duration: number;
  /** The same in frames of the result. */
  frames: number;
  /** Of which this much is the last frame held. */
  hold: number;
}

export interface TimelineNarration {
  start: number;
  duration: number;
  text: string;
}

export interface Timeline {
  segments: TimelineSegment[];
  narration: TimelineNarration[];
  totalSeconds: number;
  totalFrames: number;
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/**
 * When each clip and each voice-over starts, and how long it lasts.
 *
 * Every clip lasts a whole number of frames of the result, and starts where
 * the frames before it end. The picture is then cut to exactly these numbers
 * (see `buildRenderPlan`), so that what a file says about its own length,
 * which is often a little more than it has of picture, cannot move the
 * picture against the sound from clip to clip.
 */
export function buildTimeline(spec: Pick<RenderSpec, "clips" | "narration" | "stillSeconds">): Timeline {
  const still = Math.min(Math.max(1, spec.stillSeconds ?? DEFAULT_STILL_SECONDS), MAX_STILL_SECONDS);
  const base = spec.clips.map((clip) =>
    clip.type === "image" ? still : Math.max(0.1, clip.durationSeconds),
  );
  const durations = [...base];
  const paired = spec.narration.length > 0 && spec.narration.length === spec.clips.length;

  if (paired) {
    spec.narration.forEach((voice, i) => {
      const needed = LEAD_IN + voice.durationSeconds + TAIL;
      // A still has no length of its own: it lasts as long as what is said over it.
      if (spec.clips[i]!.type === "image") durations[i] = Math.max(2, needed);
      else if (needed > durations[i]!) durations[i] = needed;
    });
  } else if (spec.narration.length > 0 && durations.length > 0) {
    const spoken =
      LEAD_IN +
      spec.narration.reduce((sum, voice) => sum + voice.durationSeconds, 0) +
      GAP * (spec.narration.length - 1) +
      TAIL;
    const shown = durations.reduce((sum, d) => sum + d, 0);
    if (spoken > shown) durations[durations.length - 1]! += spoken - shown;
  }

  const segments: TimelineSegment[] = [];
  let framesBefore = 0;
  durations.forEach((duration, i) => {
    const frames = Math.max(1, Math.round(duration * RENDER_FPS));
    const d = frames / RENDER_FPS;
    segments.push({
      start: round(framesBefore / RENDER_FPS),
      duration: round(d),
      frames,
      hold: round(Math.max(0, d - base[i]!)),
    });
    framesBefore += frames;
  });

  const narration: TimelineNarration[] = [];
  if (paired) {
    spec.narration.forEach((voice, i) => {
      narration.push({
        start: round(segments[i]!.start + LEAD_IN),
        duration: round(voice.durationSeconds),
        text: voice.text,
      });
    });
  } else {
    let cursor = LEAD_IN;
    for (const voice of spec.narration) {
      narration.push({ start: round(cursor), duration: round(voice.durationSeconds), text: voice.text });
      cursor += voice.durationSeconds + GAP;
    }
  }
  return { segments, narration, totalSeconds: round(framesBefore / RENDER_FPS), totalFrames: framesBefore };
}

// ─── Subtitles ───────────────────────────────────────────────────────────────

export interface Caption {
  start: number;
  end: number;
  text: string;
}

/**
 * Cut what is said into pieces short enough to read at once: at the end of a
 * sentence where possible, else at a comma, else between words.
 */
export function splitCaptionText(text: string, maxChars: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…。！？]+[.!?…。！？]+["'”’)]*|[^.!?…。！？]+$/g) ?? [clean];
  const out: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence.trim();
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars + 1);
      let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
      if (cut >= maxChars * 0.4) cut += 1;
      else cut = window.lastIndexOf(" ");
      // A word longer than a line (or a script without spaces) is cut where the line ends.
      if (cut <= 0) cut = maxChars;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * Subtitles for the voice-overs: each one's text is cut into pieces, which
 * share its time in proportion to their length.
 */
export function buildCaptions(narration: TimelineNarration[], maxChars: number): Caption[] {
  const captions: Caption[] = [];
  for (const voice of narration) {
    const pieces = splitCaptionText(voice.text, maxChars);
    if (pieces.length === 0 || !(voice.duration > 0)) continue;
    // A short piece still needs a moment to be read.
    const weights = pieces.map((p) => p.length + 6);
    const total = weights.reduce((sum, w) => sum + w, 0);
    let at = voice.start;
    pieces.forEach((piece, i) => {
      const length = (voice.duration * weights[i]!) / total;
      captions.push({ start: round(at), end: round(at + length), text: piece });
      at += length;
    });
  }
  return captions;
}

function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${h}:${two(m)}:${two(s)}.${two(c)}`;
}

/** Text as an ASS event: braces and backslashes would be read as commands. */
export function assEscape(text: string): string {
  return text
    .replace(/\\/g, "/")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** Characters of subtitle that fit a frame of this shape. */
export function captionChars(width: number, height: number): number {
  return height > width ? 34 : width === height ? 40 : 58;
}

/** The subtitle file (Advanced SubStation Alpha) for a frame of this size. */
export function buildAss(
  captions: Caption[],
  frame: { width: number; height: number; fontName: string },
): string {
  const { width, height } = frame;
  const portrait = height > width;
  const size = Math.round(Math.min(width, height) * (portrait ? 0.058 : 0.062));
  const outline = Math.max(2, Math.round(size * 0.09));
  const marginSide = Math.round(width * 0.07);
  // Clear of the buttons and the description that apps put over a vertical video.
  const marginBottom = Math.round(height * (portrait ? 0.17 : 0.075));
  const fontName = frame.fontName.replace(/[,\r\n]/g, " ");
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontName},${size},&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,${outline},1,2,${marginSide},${marginSide},${marginBottom},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...captions.map(
      (c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${assEscape(c.text)}`,
    ),
    "",
  ].join("\n");
}

// ─── Frame ───────────────────────────────────────────────────────────────────

/** The output frame for a shape: 1080 on the short side, even numbers, at most 4K long. */
export function frameForShape(w: number, h: number): { width: number; height: number } {
  if (!(w > 0) || !(h > 0)) return { width: 1080, height: 1920 };
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const short = 1080;
  return w >= h
    ? { width: Math.min(even((short * w) / h), 3840), height: short }
    : { width: short, height: Math.min(even((short * h) / w), 3840) };
}

/** The output frame for an aspect ratio such as "9:16". Vertical when there is none. */
export function frameFor(aspectRatio: string | undefined): { width: number; height: number } {
  const match = aspectRatio?.match(/^(\d{1,2}(?:\.\d)?):(\d{1,2}(?:\.\d)?)$/);
  return match ? frameForShape(Number(match[1]), Number(match[2])) : frameForShape(9, 16);
}

// ─── Command ─────────────────────────────────────────────────────────────────

export interface RenderPlan {
  args: string[];
  timeline: Timeline;
  captions: Caption[];
  /** Whether the result has sound. */
  hasAudio: boolean;
}

function fixed(seconds: number): string {
  return seconds.toFixed(3);
}

/** Demuxers a stored file may be opened with, by its extension. */
const INPUT_FORMAT: Record<string, string> = {
  mp4: "mov",
  mov: "mov",
  m4a: "mov",
  webm: "matroska",
  png: "image2",
  jpg: "image2",
  webp: "image2",
  gif: "gif",
  mp3: "mp3",
  wav: "wav",
  ogg: "ogg",
  flac: "flac",
  aac: "aac",
};

/**
 * The format ffmpeg is told to read a file as. Naming it, instead of letting
 * ffmpeg guess from the content, means a file can never be opened as a
 * playlist or a script that refers to other files.
 */
export function inputFormat(file: string): string | null {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return INPUT_FORMAT[ext] ?? null;
}

export function buildRenderPlan(spec: RenderSpec): RenderPlan {
  if (spec.clips.length === 0) throw new Error("A render needs at least one clip");
  if (spec.clips.length > MAX_RENDER_CLIPS) throw new Error("Too many clips");
  const { width, height } = spec;
  const fit: RenderFit = spec.fit ?? "contain";
  const timeline = buildTimeline(spec);
  const total = timeline.totalSeconds;
  if (total > MAX_RENDER_SECONDS) {
    throw new Error(`The result would be longer than ${MAX_RENDER_SECONDS / 60} minutes`);
  }

  const args: string[] = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error"];
  const input = (file: string, options: string[] = []) => {
    const format = inputFormat(file);
    if (!format) throw new Error("Unsupported input file");
    // Local files only, read as what they are. A file name is never a pattern.
    args.push("-protocol_whitelist", "file", ...options, "-f", format);
    if (format === "image2") args.push("-pattern_type", "none");
    args.push("-i", file);
  };

  spec.clips.forEach((clip, i) => {
    if (clip.type !== "image") return input(clip.file);
    // A still is one frame, repeated for as long as it is shown.
    const shown = ["-t", fixed(timeline.segments[i]!.duration)];
    return inputFormat(clip.file) === "gif"
      ? input(clip.file, ["-ignore_loop", "0", ...shown])
      : input(clip.file, ["-loop", "1", "-framerate", String(RENDER_FPS), ...shown]);
  });
  spec.narration.forEach((voice) => input(voice.file));

  const filters: string[] = [];
  const scale =
    fit === "cover"
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;

  spec.clips.forEach((_, i) => {
    const segment = timeline.segments[i]!;
    // Exactly the planned number of frames, whatever the file holds: the last
    // frame is repeated for as long as the plan says the clip lasts, and the
    // rest is cut off. This holds a clip under a longer voice-over, and it
    // fills a clip that has less picture than its length says.
    filters.push(
      `[${i}:v:0]${scale},setsar=1,fps=${RENDER_FPS},format=yuv420p,` +
        `tpad=stop_mode=clone:stop_duration=${fixed(segment.duration)},` +
        `trim=end_frame=${segment.frames},setpts=PTS-STARTPTS[v${i}]`,
    );
  });
  const joined = spec.clips.map((_, i) => `[v${i}]`).join("");
  filters.push(`${joined}concat=n=${spec.clips.length}:v=1:a=0[vcat]`);

  const captions =
    spec.subtitles && spec.subtitleFile
      ? buildCaptions(timeline.narration, captionChars(width, height))
      : [];
  let videoLabel = "[vcat]";
  if (captions.length > 0 && spec.subtitleFile) {
    filters.push(
      `[vcat]ass=${spec.subtitleFile}${spec.fontsDir ? `:fontsdir=${spec.fontsDir}` : ""}[vsub]`,
    );
    videoLabel = "[vsub]";
  }

  // Sound: the clips' own, when it is kept, and the voice-overs over it. Its
  // lengths are counted in samples, which makes them exactly the frames'.
  const mix: string[] = [];
  const audioFormat = `aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`;
  const samples = (frames: number) => frames * SAMPLES_PER_FRAME;
  const clipSound = Boolean(spec.keepClipAudio) && spec.clips.some((c) => c.type === "video" && c.hasAudio);
  if (clipSound) {
    spec.clips.forEach((clip, i) => {
      const end = samples(timeline.segments[i]!.frames);
      if (clip.type === "video" && clip.hasAudio) {
        filters.push(`[${i}:a:0]${audioFormat},apad,atrim=end_sample=${end},asetpts=PTS-STARTPTS[a${i}]`);
      } else {
        filters.push(
          `anullsrc=channel_layout=stereo:sample_rate=${AUDIO_RATE},atrim=end_sample=${end},asetpts=PTS-STARTPTS[a${i}]`,
        );
      }
    });
    const labels = spec.clips.map((_, i) => `[a${i}]`).join("");
    const volume = spec.narration.length > 0 ? ",volume=0.25" : "";
    filters.push(`${labels}concat=n=${spec.clips.length}:v=0:a=1${volume}[clips]`);
    mix.push("[clips]");
  }
  spec.narration.forEach((_, j) => {
    const index = spec.clips.length + j;
    const delay = Math.round(timeline.narration[j]!.start * 1000);
    // A delay for each of the two channels: saying it once for all of them
    // ("all=1") needs ffmpeg 4.3.
    const delayed = delay > 0 ? `,adelay=${delay}|${delay}` : "";
    filters.push(`[${index}:a:0]${audioFormat}${delayed}[n${j}]`);
    mix.push(`[n${j}]`);
  });
  const hasAudio = mix.length > 0;
  if (hasAudio) {
    const whole = `apad,atrim=end_sample=${samples(timeline.totalFrames)}`;
    if (mix.length === 1) {
      filters.push(`${mix[0]}${whole}[aout]`);
    } else {
      // Mixed at full level. amix turns every input down by the number of
      // inputs that are playing, and switching that off ("normalize=0") needs
      // ffmpeg 4.4. So every input is made as long as the video, which keeps
      // that number the same from start to end, and the sum is turned up by it.
      mix.forEach((label, k) => filters.push(`${label}${whole}[m${k}]`));
      const inputs = mix.map((_, k) => `[m${k}]`).join("");
      filters.push(`${inputs}amix=inputs=${mix.length}:duration=first,volume=${mix.length}[aout]`);
    }
  }

  args.push("-filter_complex", filters.join(";"), "-map", videoLabel);
  if (hasAudio) args.push("-map", "[aout]");
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(RENDER_FPS),
  );
  if (hasAudio) args.push("-c:a", "aac", "-b:a", "160k", "-ar", String(AUDIO_RATE));
  args.push("-t", fixed(total), "-movflags", "+faststart", "-f", "mp4", spec.output);

  return { args, timeline, captions, hasAudio };
}

// ─── Probe ───────────────────────────────────────────────────────────────────

export interface MediaInfo {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** Read what `ffmpeg -i <file>` prints about a file. */
export function parseProbe(stderr: string): MediaInfo {
  const info: MediaInfo = { durationSeconds: null, width: null, height: null, hasVideo: false, hasAudio: false };
  const duration = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (duration) {
    info.durationSeconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  }
  for (const line of stderr.split("\n")) {
    if (!/^\s*Stream #/.test(line)) continue;
    if (/: Audio:/.test(line)) info.hasAudio = true;
    // A cover picture inside an audio file is not a video.
    if (/: Video:/.test(line) && !/attached pic/.test(line)) {
      info.hasVideo = true;
      const size = line.match(/[\s,](\d{2,5})x(\d{2,5})[\s,[]/);
      if (size && info.width === null) {
        info.width = Number(size[1]);
        info.height = Number(size[2]);
      }
    }
  }
  return info;
}

/** Length of a WAV file from its header, when it can be read. */
export function wavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let at = 12;
  let byteRate = 0;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    if (id === "fmt " && at + 20 <= bytes.length) byteRate = view.getUint32(at + 16, true);
    if (id === "data") {
      if (!(byteRate > 0)) return null;
      // A streamed file may declare a size it does not have.
      const available = Math.min(size, bytes.length - (at + 8));
      return available / byteRate;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}
