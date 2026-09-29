# Procedure: damaged or wrong item

Candidate focused procedure, version 2 (2026-09-29). Proposed for the customer service lead to adopt; it
is not active training and grants no authority.

## Applies when

The customer reports that a received item is damaged, wrong, or does not match the listing.

Does not apply to: an item that has not arrived, a fitment question before purchase, or a return of an
unused item the customer simply no longer wants.

## Read first

1. Every message on the case, newest last. The latest customer message governs; a correction replaces
   what the customer said earlier.
2. Every attachment already supplied. Never ask for something the customer already sent.
3. The order: which items shipped, and how many of each.
4. Any recorded human direction on the case. A hold, reject or defer binds: send nothing.

## Decide the next step

| Situation | Step |
| --- | --- |
| A person placed a hold, rejected or deferred | `wait` |
| The customer only acknowledges a resolved case | `close_without_reply` |
| The customer reports physical damage (cracked, broken, bent, leaking) | `raise_decision`. A label photo does not show damage, and a damage photo is outside standing authority |
| The item looks wrong or does not match the listing, and a legible product-label photo of it is missing | `send_message` requesting that one photo |
| The label photo is already on the case | `raise_decision` with the evidence and one recommended remedy |
| Anything other than the label photo is needed from the customer | `raise_decision` |
| The customer asks for money back, a replacement or an exception | `raise_decision`; promise nothing |
| A send, lookup or tool fails | `report_technical_blocker` naming the failure |

## Asking for the photo

- Ask for one thing: a clear photo of the product label.
- When one unit shipped, the request is about that unit. Do not ask which item.
- When several items shipped and the customer named one, the request is about the named item.
- When several items shipped and the customer named none, ask for the label photo of the item in
  question. Do not ask for photos of every item.
- Do not ask for the order number, model number or installation photos.
- Send from the account on the case to the customer on the case.
- Make no promise about refund, replacement, reshipment, discount, fit or delivery date.

## Done

The request is sent and its receipt recorded. The case stays open and owned until the customer
replies; a sent request does not resolve the case.

## Versions

- Version 2, 2026-09-29: separated physical damage from a wrong item after scenario
  `damage-photo-outside-authority` failed on version 1, which let a damage report be answered with a
  label-photo request.
- Version 1, 2026-09-29: first draft.
