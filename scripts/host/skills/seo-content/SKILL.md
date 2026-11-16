---
name: seo-content
description: On-page SEO for pages, product listings and articles, so that the people looking for them find them. Use when planning or reviewing any page that will be published.
---

# Being found

Search engines reward the page that answers the searcher best. Tricks do not outlast an update; a clear answer does.

## 1. Intent before keywords

For each page, write: the query a person types, what they want when they type it (to learn, to compare, to buy, to find a place), and what would satisfy them. One main query a page; two or three close variants. Use the words searchers use (for an Indonesian audience, the Indonesian phrase people really type, including common spellings).

You cannot measure search volume without a tool. Say that your keyword choice is a reasoned assumption and should be checked in Search Console or a keyword tool.

## 2. The page

- **Title** (50 to 60 characters): the main phrase near the front, then what makes this page the one to click. Unique for every page.
- **Meta description** (120 to 155 characters): what the page gives and a reason to click. Not a list of keywords.
- **URL**: short, lower case, hyphens, the main words (`/sepatu-lari-pria`), stable.
- **One `h1`** that says what the page is; `h2` for the parts a reader would look for.
- **The answer early.** The first paragraph says the main thing. Details follow.
- **Images**: descriptive file names and `alt`, compressed, with dimensions.
- **Internal links**: from this page to the next useful one with words that say what is there; to this page from the pages that mention its subject.
- **No stuffing.** A phrase repeated to rank reads badly and does not rank.

## 3. Structured data

Add JSON-LD that matches what is visibly on the page, and only that:

- Store product page: `Product` with `name`, `image`, `description`, `sku`, `offers` (`price`, `priceCurrency` such as `IDR`, `availability`). `AggregateRating` only with real reviews shown on the page.
- Article: `Article` or `BlogPosting` with `headline`, `datePublished`, `dateModified`, `author`.
- A shop with a place: `LocalBusiness` with address, opening hours, phone.
- Questions actually answered on the page: `FAQPage`.
- `BreadcrumbList` where there are breadcrumbs.

Invented ratings or reviews in structured data are a violation and can remove the page from results.

## 4. Site-level basics

- One canonical URL for each page (`<link rel="canonical">`); filters and sort orders do not create indexable duplicates.
- `sitemap.xml` and `robots.txt` (do not block CSS or scripts the page needs).
- Fast and usable on a phone: see the web build standards.
- HTTPS everywhere; a real 404 page; redirects (301) when a URL changes.

## 5. Articles

- Outline from the questions people ask, in the order they ask them.
- Say something a reader could not get from the first three results: an example with numbers, a step-by-step from experience, a comparison table, a clear recommendation and for whom.
- Sources linked for every fact that is not common knowledge. Do not invent statistics or quotes.
- Name the author and what they know about it; date the article; update rather than republish.

## Deliverable

For a page: the query and intent; title; meta description; URL; the heading outline; the JSON-LD; internal links in and out; what is assumed and should be measured after launch.

For a review: what is missing or wrong, each with the fix, most harmful first.
