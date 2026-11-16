---
name: web-build-quality
description: Engineering standards for a website that is fast, accessible and finished. Use when writing or reviewing HTML, CSS, JavaScript or a front-end framework.
---

# A website that is finished

## Markup

- Semantic elements: `header`, `nav`, `main`, `section` with a heading, `article`, `footer`, `button` for actions, `a` for navigation. One `h1` a page, headings in order.
- Every image has `width` and `height` (no layout shift), `alt` that says what it shows (empty `alt=""` for decoration), `loading="lazy"` below the first screen.
- Forms: a `label` for every field, the right `type` and `autocomplete`, `inputmode` for numbers, errors next to the field in words, never colour alone.
- `lang` on `html` (`id` for Indonesian). A real `title` and meta description per page.

## Layout and style

- Mobile first: design at 360 px, then add breakpoints where the content needs them, not at device names.
- Design tokens as CSS custom properties (`--color-accent`, `--space-3`, `--radius-1`). No magic numbers scattered in rules.
- System font stack or one self-hosted variable font with `font-display: swap`. No more than two font files on the first screen.
- Fluid type and spacing with `clamp()` where it helps; a readable measure (`max-width: 65ch`) for text.
- Focus is visible on every interactive element. Touch targets at least 44 by 44 px. Respect `prefers-reduced-motion`.
- No horizontal scroll at any width from 320 px.

## Behaviour

- The page works before JavaScript runs where it can: links are links, forms post. Enhance, do not replace.
- Every asynchronous action has four states: idle, working (the control disabled, a sign of progress), success, failure with a way to retry.
- Validate on the server as well as in the browser. Never trust a price, a role or an ID that comes from the client.
- No secrets in front-end code. Keys that must be public are named as such.

## Speed

Budget for a product or landing page on mobile data: largest content painted within 2.5 s, layout shift under 0.1, under 200 KB of JavaScript compressed for the first load.

- Images in modern formats (AVIF or WebP with a fallback), sized to their slot with `srcset` / `sizes`; the hero image preloaded, everything else lazy.
- CSS for the first screen is small; scripts are `defer` or modules; third-party scripts are few and loaded last.
- Cache static files with a content hash in the name.

## Structure of what you deliver

- A layout a person can find their way in: `src/` or `site/`, `assets/`, one file per component or page, a short `README.md` with how to run and build.
- Code complete enough to run: no `...`, no "rest of the code here", no functions that are named and not written. If a part cannot be finished, say which and why.
- Real content from the brief in the markup. A gap is `TODO(client): ...` in a comment and in your summary, never lorem ipsum.

## Self-check before handing in

1. Read the HTML without the CSS: does it make sense top to bottom?
2. Tab through the page: can everything be reached and seen?
3. Narrow to 360 px: anything cut off, overlapping or too small to tap?
4. Turn images off: is anything important lost?
5. What happens with no network, with a slow one, with an empty list, with a very long name?
6. List what you did not test (you cannot run a browser unless you have a tool for it), so that a person does.
