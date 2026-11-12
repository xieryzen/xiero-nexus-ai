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

/**
 * A Reel: a short vertical video made of separately generated clips.
 *
 *   1  Concept and script      text
 *   2  Storyboard              text   needs 1
 *   3… Scene k clip            video  needs 2   (one per scene, run in parallel)
 *      Cover image             image  needs 1, 2
 *      Caption and hashtags    text   needs 1
 *
 * The clips stay separate files. Nothing is stitched together.
 */
export function reelWorkflowTemplate(
  opts: { scenes?: number; clipSeconds?: number } = {},
): WorkflowTemplate {
  const scenes = clampInt(opts.scenes, 1, REEL_MAX_SCENES, REEL_DEFAULT_SCENES);
  const seconds = clampInt(opts.clipSeconds, 1, REEL_MAX_CLIP_SECONDS, REEL_DEFAULT_CLIP_SECONDS);
  const total = scenes * seconds;
  const sceneWord = scenes === 1 ? "scene" : "scenes";

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

  for (let k = 1; k <= scenes; k++) {
    steps.push({
      title: `Scene ${k} clip`,
      role: "Video Artist",
      kind: "video",
      media: { aspectRatio: REEL_ASPECT_RATIO, durationSeconds: seconds },
      dependsOn: [2],
      objective:
        `Scene ${k} of the storyboard, and only that scene. Describe it for a video generator: the ` +
        "subject and what it does, the setting, the camera movement, and the storyboard's visual " +
        `style, so that it matches the other scenes. Vertical ${REEL_ASPECT_RATIO}, about ${seconds} ` +
        "seconds, no text on screen.",
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

  return {
    name: `Reel (${scenes} ${sceneWord})`,
    description:
      `Script, storyboard, ${scenes} vertical ${sceneWord} of ${seconds} s, a cover image and a ` +
      "caption. The project needs a video model and an image model.",
    steps,
  };
}
