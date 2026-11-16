---
name: brochure-catalog
description: How to plan, write and lay out a brochure or a product catalogue for print and PDF, as HTML and CSS that prints correctly. Use for brochures, flyers, price lists and catalogues.
---

# Brochures and catalogues

A printed piece is read in the hand, once, in order. It needs one job, a clear path for the eye and facts that are right, because print cannot be corrected.

## 1. Decide before designing

- **Job**: what should the reader do after reading (visit, order, call, keep the price list)?
- **Format**: A4 (210 x 297 mm) or A5 (148 x 210 mm) pages; a tri-fold is A4 landscape in three panels of about 99 mm; a catalogue is a multiple of 4 pages when it is stapled.
- **Where it is read**: handed over at a stand, sent as PDF on WhatsApp, left at a counter. A PDF for the phone wants larger type and one column.
- **Content inventory**: every product with its exact name, code, size or spec, price and unit, and its picture. A missing item is listed as `TODO(client)`, never made up. Prices and phone numbers are copied, not retyped from memory, and listed again at the end for the client to confirm.

## 2. Structure

Brochure (one sheet or a few pages):

1. Cover: what it is and for whom, one strong picture, the name.
2. Inside: the offer in the order a buyer asks (what, for whom, what you get, how much, how to get it).
3. Proof that is real: a photo of the work, a guarantee with its terms.
4. Back: how to order, contact, address or map, opening hours, a QR code target (say what URL it points to).

Catalogue:

1. Cover, then contents when there are more than 8 pages.
2. Sections by how buyers choose (use, size, price range), each opened by a short line.
3. Product entries all built the same way: picture, name, code, two to four spec lines, price with unit. A table when products differ only in numbers.
4. Ordering terms, delivery, validity of the prices ("Harga berlaku sampai ..."), contact.

## 3. Layout rules

- A grid: for A4, 12 columns with 4 to 5 mm gutters, margins of 12 to 15 mm; text never closer than 5 mm to the trim.
- Type for print: body 9 to 11 pt with 130 to 145 % line height; captions 7.5 to 8.5 pt; headings in a clear step up. One family, two at most. Prices in tabular figures, aligned on the right.
- Hierarchy on every page: one thing largest, one path through the rest.
- Pictures large and few rather than small and many. Every product picture cut and lit the same way.
- White space is part of the layout: a full page is a tired page.
- One accent colour. Black text is black only (not a mix), so it prints sharp.

## 4. Print facts to state in the handover

- Bleed: backgrounds and pictures that touch the edge extend 3 mm past the trim.
- Pictures need about 300 dpi at printed size: a 1024 px picture prints well up to about 8.5 cm wide. Generated pictures are placeholders at this size; say where real photos are needed.
- Screen colours (RGB) shift in print (CMYK). Brand colours should be checked on a proof.
- The printer wants a PDF with fonts embedded, at the trim size plus bleed. Say which paper and finish were assumed.

## 5. HTML and CSS that print

Deliver one self-contained HTML file per piece. Minimum:

```css
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; }
.page { width: 210mm; height: 297mm; padding: 14mm; position: relative; overflow: hidden; break-after: page; }
.page:last-child { break-after: auto; }
@media screen { body { background: #ddd; } .page { margin: 8mm auto; background: #fff; } }
@media print { .page { margin: 0; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
```

- Use millimetres and points, CSS grid for the columns, `break-inside: avoid` on product entries and table rows.
- Pictures are referenced by a clear file name in an `images/` folder next to the HTML (`images/cover.jpg`), with a list of which picture goes where. Do not embed large data URLs.
- Fonts: a system stack or a font the client has the licence for. No web font that would be missing when printed offline.
- Say how to make the PDF: open the file in a browser, Print, "Save as PDF", paper size as designed, margins "None", background graphics on.

## 6. Check before handing over

- Every price, code, phone number and address against the brief, listed for the client to sign off.
- Nothing important within 5 mm of an edge; nothing running across a fold.
- Same entry structure on every catalogue page.
- Spelling of names and products.
- Read it as the customer: is the next step obvious on the last panel?
