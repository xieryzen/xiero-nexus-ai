/**
 * Built-in creative workflow templates. Pure, so the steps a template produces
 * can be unit-tested and are the same in the builder and in the tests.
 */
import type { MediaOptions, TaskKind } from "./prompt";

export interface TemplateStep {
  title: string;
  objective: string;
  acceptanceCriteria?: string;
  role: string;
  /** Step numbers (1-based) this step needs the output of. */
  dependsOn?: number[];
  kind?: TaskKind;
  media?: MediaOptions;
}

export interface WorkflowTemplate {
  name: string;
  description: string;
  steps: TemplateStep[];
}

export const REEL_ASPECT_RATIO = "9:16";
export const REEL_DEFAULT_SCENES = 3;
export const REEL_MAX_SCENES = 8;
export const REEL_DEFAULT_CLIP_SECONDS = 8;
export const REEL_MAX_CLIP_SECONDS = 20;

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface ReelOptions {
  scenes?: number;
  clipSeconds?: number;
  /**
   * Generate a still for each scene first and start the scene's clip from it
   * (image-to-video). Keeps the look of the scenes together.
   */
  keyframes?: boolean;
  /** Have each scene's line of the script spoken. Needs a speech model. */
  voiceOver?: boolean;
  /** The voice, as the speech provider names it. */
  voice?: string;
  /** Join the clips, with the voice-overs over them, into one video. Needs ffmpeg on the server. */
  join?: boolean;
  /** Burn the spoken words into the joined video. */
  subtitles?: boolean;
}

/**
 * A Reel: a short vertical video made of separately generated clips.
 *
 *   1  Concept and script      text
 *   2  Storyboard              text    needs 1
 *   per scene (the scenes run in parallel):
 *      Scene k keyframe        image   needs 2          (with keyframes)
 *      Scene k clip            video   needs 2, and starts from the keyframe
 *      Scene k voice-over      audio   needs 1          (with voice-over)
 *      Final cut               render  needs every clip and voice-over (with join)
 *      Cover image             image   needs 1, 2
 *      Caption and hashtags    text    needs 1
 *
 * Without the options it is the v1.4 template: the clips stay separate files.
 */
export function reelWorkflowTemplate(opts: ReelOptions = {}): WorkflowTemplate {
  const scenes = clampInt(opts.scenes, 1, REEL_MAX_SCENES, REEL_DEFAULT_SCENES);
  const seconds = clampInt(opts.clipSeconds, 1, REEL_MAX_CLIP_SECONDS, REEL_DEFAULT_CLIP_SECONDS);
  const total = scenes * seconds;
  const sceneWord = scenes === 1 ? "scene" : "scenes";
  const keyframes = Boolean(opts.keyframes);
  const voiceOver = Boolean(opts.voiceOver);
  const join = Boolean(opts.join);
  const subtitles = join && voiceOver && Boolean(opts.subtitles);
  const voice = opts.voice?.trim() || undefined;

  const steps: TemplateStep[] = [
    {
      title: "Concept and script",
      role: "Creative Director",
      objective:
        `Plan a short vertical video (a Reel, about ${total} seconds) for the project goal. Give: ` +
        "(1) the hook, one line that earns the first two seconds; " +
        "(2) the single message the viewer should leave with; " +
        `(3) a voiceover script in exactly ${scenes} ${sceneWord} of about ${seconds} seconds each, ` +
        `one or two short spoken sentences per scene, numbered from Scene 1 to Scene ${scenes}.`,
      acceptanceCriteria: `A hook, a message, and exactly ${scenes} numbered ${sceneWord} that can each be spoken in about ${seconds} seconds.`,
    },
    {
      title: "Storyboard",
      role: "Creative Director",
      dependsOn: [1],
      objective:
        "Turn the script into a storyboard. Start with one line that fixes the visual style of the " +
        "whole video (look, colour palette, lighting). Then, for each scene, numbered as in the " +
        "script: what is on screen (subject, setting, action), the camera movement, and any text to " +
        `add on screen later. Every scene is vertical ${REEL_ASPECT_RATIO} and about ${seconds} seconds.`,
      acceptanceCriteria: `One style line, then exactly ${scenes} numbered ${sceneWord}.`,
    },
  ];

  const clipSteps: number[] = [];
  const voiceSteps: number[] = [];
  for (let k = 1; k <= scenes; k++) {
    let keyframe: number | null = null;
    if (keyframes) {
      steps.push({
        title: `Scene ${k} keyframe`,
        role: "Designer",
        kind: "image",
        media: { aspectRatio: REEL_ASPECT_RATIO },
        dependsOn: [2],
        objective:
          `The opening frame of scene ${k} of the storyboard, and only that scene: one still that ` +
          "shows its subject and setting at the moment the scene begins, in the storyboard's visual " +
          `style, so that it matches the other scenes. Vertical ${REEL_ASPECT_RATIO}, no text in the image.`,
      });
      keyframe = steps.length;
    }
    steps.push({
      title: `Scene ${k} clip`,
      role: "Video Artist",
      kind: "video",
      media: {
        aspectRatio: REEL_ASPECT_RATIO,
        durationSeconds: seconds,
        ...(keyframe ? { imageFrom: keyframe } : {}),
      },
      dependsOn: keyframe ? [2, keyframe] : [2],
      objective:
        `Scene ${k} of the storyboard, and only that scene. Describe it for a video generator: the ` +
        "subject and what it does, the setting, the camera movement, and the storyboard's visual " +
        `style, so that it matches the other scenes. Vertical ${REEL_ASPECT_RATIO}, about ${seconds} ` +
        "seconds, no text on screen." +
        (keyframe
          ? " The clip starts from this scene's keyframe image: say how that picture comes to life."
          : ""),
    });
    clipSteps.push(steps.length);
    if (voiceOver) {
      steps.push({
        title: `Scene ${k} voice-over`,
        role: "Creative Director",
        kind: "audio",
        media: { durationSeconds: seconds, ...(voice ? { voice } : {}) },
        dependsOn: [1],
        objective:
          `The voiceover of scene ${k} from the script, and only that scene: the words as they are ` +
          `spoken, one or two short sentences that take about ${seconds} seconds to say. Keep the ` +
          "script's wording unless a phrase is hard to say aloud.",
      });
      voiceSteps.push(steps.length);
    }
  }

  if (join) {
    steps.push({
      title: "Final cut",
      role: "Video Artist",
      kind: "render",
      media: { aspectRatio: REEL_ASPECT_RATIO, ...(voiceOver ? { subtitles } : {}) },
      dependsOn: [...clipSteps, ...voiceSteps],
      objective:
        `Join the ${scenes} scene ${scenes === 1 ? "clip" : "clips"} in order into one vertical video` +
        (voiceOver
          ? `, with each scene's voice-over over its clip${subtitles ? " and its words as subtitles" : ""}.`
          : "."),
    });
  }

  steps.push(
    {
      title: "Cover image",
      role: "Designer",
      kind: "image",
      media: { aspectRatio: REEL_ASPECT_RATIO },
      dependsOn: [1, 2],
      objective:
        "The cover frame of the Reel: one striking still that shows the hook, in the storyboard's " +
        `visual style, vertical ${REEL_ASPECT_RATIO}, with clear space in the upper third for a title. ` +
        "No text in the image.",
    },
    {
      title: "Caption and hashtags",
      role: "Copywriter",
      dependsOn: [1],
      objective:
        "Write the caption for the post: the hook as the first line, two or three short lines that " +
        "deliver the message, and a call to action. Then 8 to 12 relevant hashtags on a last line.",
    },
  );

  const extras = [
    keyframes ? "keyframes" : "",
    voiceOver ? "voice-over" : "",
    join ? (subtitles ? "joined, subtitles" : "joined") : "",
  ].filter(Boolean);
  return {
    name: `Reel (${scenes} ${sceneWord}${extras.length ? `, ${extras.join(", ")}` : ""})`,
    // What the workflow makes: everyone who may choose it reads this. What a
    // project needs to run it is said where a workflow is built (needsInWords).
    description:
      `Script, storyboard, ${scenes} vertical ${sceneWord} of ${seconds} s` +
      (keyframes ? ", each started from its own keyframe image" : "") +
      (voiceOver ? ", a voice-over for each" : "") +
      (join ? `, joined into one video${subtitles ? " with subtitles" : ""}` : "") +
      ", a cover image and a caption.",
    steps,
  };
}

/** What a template's steps ask of a project: how many tasks and how much generated media. */
export function templateNeeds(steps: { kind?: TaskKind }[]): {
  tasks: number;
  media: number;
  image: boolean;
  video: boolean;
  audio: boolean;
  render: boolean;
} {
  const count = (kind: TaskKind) => steps.filter((s) => (s.kind ?? "text") === kind).length;
  const image = count("image");
  const video = count("video");
  const audio = count("audio");
  return {
    tasks: steps.length,
    media: image + video + audio,
    image: image > 0,
    video: video > 0,
    audio: audio > 0,
    render: count("render") > 0,
  };
}

/**
 * What a project and the server must have for steps like these, as a sentence
 * for whoever sets a project up: "The project needs a video model and an
 * image model, and the server needs ffmpeg." Empty when they need nothing.
 */
export function needsInWords(needs: Pick<ReturnType<typeof templateNeeds>, "image" | "video" | "audio" | "render">): string {
  const models = [
    needs.video ? "a video model" : "",
    needs.image ? "an image model" : "",
    needs.audio ? "a speech model" : "",
  ].filter(Boolean);
  const list = models.length <= 2 ? models.join(" and ") : `${models.slice(0, -1).join(", ")} and ${models[models.length - 1]}`;
  const parts = [models.length > 0 ? `the project needs ${list}` : "", needs.render ? "the server needs ffmpeg" : ""].filter(Boolean);
  if (parts.length === 0) return "";
  const sentence = parts.join(", and ");
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`;
}
