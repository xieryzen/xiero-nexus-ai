---
name: anti-ai-slop-design
description: Design and review rules that keep a website, a store or a brochure from looking machine-made. Use for any visual or interface work, and when reviewing one.
---

# Design that does not look machine-made

"AI slop" is work that could belong to anyone: the same gradient, the same three cards, the same words. A client pays for work that could only be theirs. Every choice below is there to make the result specific.

## Before any layout

1. Write down, in two lines, who the buyer is and the one thing they came to do.
2. Collect what is real: the actual products, prices, photos, the shop's voice, its city, its guarantees. Ask for what is missing; mark every gap as `TODO(client): ...`. Never fill a gap with invented facts, invented testimonials or invented numbers.
3. Pick a direction in one sentence that a stranger could picture ("a quiet hardware catalogue: off-white paper, one red, tight tables") and hold every later choice against it.

## What gives the machine away: do not ship these

- Purple-to-blue or pink-to-orange gradients as the main look; glowing blobs; glass panels on everything.
- A centred hero with a vague headline ("Elevate your experience", "Solusi terbaik untuk Anda"), two buttons and a floating mock-up.
- Three or four equal cards with an icon, a two-word title and one line each, repeated section after section.
- Emoji as icons or bullets. Sparkles. Rocket ships.
- Every corner rounded the same large amount; every card with the same soft shadow.
- Stock-like pictures of people pointing at laptops; generated faces; pictures that do not show the product.
- Fake proof: "Trusted by 10,000+", five-star rows without a source, logos of companies that are not clients.
- Lorem ipsum, "Product name", "Feature one", or any text that would fit another business unchanged.
- Sections that exist because pages usually have them (a "Why choose us" with nothing to say).
- Animation on scroll for everything; text that fades in before it can be read.

## What to do instead

- **Type first.** One typeface family, or two with a clear job each (one for headings, one for text). A real scale, for example 14 / 16 / 20 / 28 / 40 px, with line heights set for each. Body text 16 px or more, 60 to 75 characters a line.
- **Colour with restraint.** One background, one text colour, one accent that means "act here", and at most one supporting colour. Give exact values and say what each is for. Contrast at least 4.5:1 for text.
- **A grid, and a reason to break it.** Name the columns and gutters. Vary the rhythm: a dense table next to open space reads as designed; equal boxes read as generated.
- **Show the thing.** The product, its details, its size next to a hand, the packaging, the place. A real photo taken on a phone beats a perfect generic one.
- **Specific words.** Headline = what it is + for whom + what makes it different, with a number or a name in it. Buttons say what happens ("Tambah ke keranjang", "Lihat ongkir"), never "Learn more".
- **States are design.** Empty cart, out of stock, wrong address, slow network, payment failed: each has a designed screen and a sentence that helps.
- **One strong idea a page.** A single unexpected but fitting element (an oversized price, a hand-drawn map, a full-width table) does more than ten effects.
- **Radius, border and shadow are choices.** Pick one treatment for surfaces (hairline borders, or shadows, not both) and two radii at most.

## Deliverable format for a design spec

1. Direction (one sentence) and what it rules out.
2. Tokens: colours with hex and role; type scale; spacing scale; radii; borders.
3. For each page or spread: purpose, the order of blocks with the real text in them, and each state.
4. Assets: which real pictures are needed, and which are generated placeholders to be replaced.
5. Open questions, each with a default so that work can go on.

## Review checklist (name the rule that is broken)

- Could this page be another company's if the logo were swapped? Where exactly?
- Is any fact, number, review or logo not supplied by the client?
- Is there filler: a section, a sentence or an effect that could be cut with no loss?
- Does the first screen say what is sold, to whom and for how much (or how to find out)?
- One accent colour only? Text contrast measured?
- Does it work at 360 px wide, with a thumb, on a slow connection?
- Are empty, loading and error states there?

End a review with what must change before it ships, in order of harm, and what is fine as it is.
