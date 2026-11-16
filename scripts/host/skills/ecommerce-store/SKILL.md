---
name: ecommerce-store
description: How an online store is planned and built so that people can find, trust, buy and receive. Use for any e-commerce site, catalogue with ordering, or checkout work, with notes for the Indonesian market.
---

# Building an online store

A store is judged by four moments: can I find it, do I trust it, can I pay, did it arrive. Plan and review along those.

## 1. Decide the shape first

Write these down before any page:

- What is sold (physical, digital, service, made to order), how many products, how often they change.
- Who buys, on which device (assume a phone, 360 px wide, mobile data).
- How an order is fulfilled: stock or pre-order, who packs, which couriers, which cities.
- How money comes in: which payment methods, who reconciles them, refunds.
- Who runs it day to day and what they can manage (this decides how much admin to build).

State every assumption. A choice the brief leaves open gets a default and a reason.

## 2. Structure

- **Home**: what is sold and for whom on the first screen, the two or three ways in (categories, best sellers, search), one proof that is real. No carousel that hides products.
- **Category / listing**: filters that match how people choose (size, price, use), sort, the product photo, name, price, stock state. Show the count.
- **Product page**: photos of the thing (several angles, scale, detail), name, price (and the unit), variants that show which are out of stock, what is in the box, size or spec table, shipping estimate before the cart, return terms, then reviews if there are real ones.
- **Cart**: editable, shows shipping and total as early as they can be known, no surprise fee at the end.
- **Checkout**: guest checkout allowed; as few fields as the courier needs; address with province / city / district / postcode; phone number (couriers call); order summary always visible; one clear pay button.
- **After payment**: an order page with a status that updates, and a message by e-mail or WhatsApp with the order number.
- **Static**: shipping, returns, contact with a real address or map, privacy.

## 3. Indonesian market notes

- Payments people expect: QRIS, bank virtual accounts, e-wallets, cards, sometimes COD and bank transfer with proof. These come through a payment gateway (for example Midtrans, Xendit, DOKU, Tripay, Duitku). Which one is the client's choice: name the one assumed, and never write real keys into code.
- Shipping rates come from a rates API (for example RajaOngkir, Biteship) or a fixed table. Couriers buyers know: JNE, J&T, SiCepat, AnterAja, Pos, GoSend / GrabExpress for same day.
- Prices in rupiah as `Rp 125.000` (dot as thousands separator, no decimals). Say whether tax is included.
- WhatsApp is a sales channel: a "Tanya via WhatsApp" link with the product name pre-filled is worth more than a contact form.
- Check a named service's current API and fees in its own documentation before building on it. Say what you could not verify.

## 4. Data and order states

Minimum entities: product, variant (SKU, price, stock), category, cart, order, order line (price copied at purchase), customer, address, payment, shipment.

Order states, in one direction with explicit exits: `pending_payment` → `paid` → `processing` → `shipped` → `delivered`; `cancelled` and `refunded` from where the business allows. Every change records who or what did it and when.

Rules that prevent the usual damage:

- The price and stock are checked again on the server when the order is placed.
- Stock is reduced in one transaction with the order; payment confirmation comes from the gateway's server-to-server notification (webhook), verified by signature, never from the browser coming back.
- A webhook may arrive twice or late: handling it twice changes nothing the second time.
- Money is stored as integers (rupiah), never floats.

## 5. Trust and law

- Real contact details, real photos, clear return terms, the total before paying.
- Collect only what an order needs. Passwords hashed; payments on the gateway's page or its hosted fields; no card numbers in your database.
- Admin behind sign-in with roles; every admin action that changes an order is logged.

## 6. Done means

- A stranger can buy on a phone in under two minutes without help.
- An order can be followed from payment to delivery by the buyer and by the admin.
- Out of stock, payment failed, payment pending, wrong address and cancelled each have a screen and a sentence that helps.
- Search engines get a title, a description and product structured data for each product (see the SEO skill if you have it).
- A launch checklist exists: test order with each payment method in the gateway's sandbox, a refund, a shipping rate for a far city, the e-mail or WhatsApp messages, backups.
