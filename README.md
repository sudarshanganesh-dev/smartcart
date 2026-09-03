# SmartCart

### AI Growth & Agentic Commerce for Razorpay AI Buildathon 2026

SmartCart is an AI-assisted commerce system that helps merchants not only complete purchases, but also learn from purchases that could not happen.

Instead of treating failed product searches as dead ends, SmartCart captures repeated unmet buying intent, turns it into a merchant-reviewed revenue opportunity, and measures whether acting on that opportunity results in paid revenue.

> **Customer demand → Verified decision → Transaction → Lost demand → Merchant opportunity → New product → Paid order → Measured revenue**

## Demo

**Video:** https://youtu.be/JTWRIrNB2hM

**Track:** Track 1 — AI Growth & Agentic Commerce

---

## The Problem

Merchants already know what customers successfully purchased.

What is harder to see is what customers **wanted to purchase but could not**.

A customer may leave because:

- the requested product does not exist,
- the product is out of stock,
- there is not enough stock,
- the available option does not fit the customer's budget, or
- the catalog does not contain a suitable alternative.

These failed buying attempts contain useful demand information.

SmartCart treats them as **demand signals**.

When similar unmet intent appears repeatedly, SmartCart can surface an actionable opportunity to the merchant.

---

## What SmartCart Does

SmartCart has two connected experiences.

### 1. AI Buyer Experience

Customers can describe what they want using natural language.

For example:

> "I need cake and cookies for my girlfriend's birthday under ₹1200."

Gemini interprets the customer's intent, occasion and preferences.

SmartCart then searches the merchant's actual approved catalog and verifies the final purchase plan before allowing it to move toward checkout.

### 2. Merchant Growth Experience

When SmartCart cannot satisfy a customer's request, the failure can be recorded as a demand event.

Repeated demand is analyzed and converted into merchant opportunities such as:

- Create Product
- Create Variant
- Add Option
- Restock Product
- Increase Stock

The merchant remains responsible for the final business decision.

AI recommendations do not automatically become sellable products.

---

# AI Judgment

One of the main design decisions in SmartCart is deciding **where AI should and should not be used**.

## Gemini is used for

- understanding natural-language shopping requests,
- extracting intent and preferences,
- interpreting occasions and goals,
- translating abstract intent into useful catalog searches,
- producing conversational responses,
- assisting with merchant-facing recommendations.

## Deterministic application logic is used for

- product approval checks,
- price validation,
- currency validation,
- stock validation,
- availability checks,
- budget enforcement,
- cart state,
- bundle verification,
- checkout amount calculation,
- Razorpay payment verification,
- revenue attribution.

The language model is therefore **not the source of truth for commerce data**.

> **Gemini understands the customer. SmartCart verifies what can actually be sold.**

---

# Decision Engine

SmartCart includes a deterministic Decision Engine for multi-product purchase decisions.

The engine verifies:

1. Customer intent has been interpreted.
2. Matching catalog products exist.
3. Products are approved for sale.
4. Products are currently available.
5. Requested preferences are covered.
6. The final combination stays within the customer's budget.
7. The resulting plan can safely be added to the cart.

For bundle requests, candidate combinations are evaluated using actual catalog data rather than allowing the language model to invent a purchase plan.

If SmartCart does not have enough evidence to make a safe decision, it asks the customer for clarification instead of guessing.

For example, if a customer asks:

> "Plan a birthday celebration for 10 people under ₹3000."

but the catalog does not contain serving-capacity data, SmartCart does not assume quantities based on the group size.

---

# Explainable, Bounded and Gated Actions

SmartCart was designed around three principles for AI-assisted commerce.

## Explainable

The Decision Engine exposes the reasoning path behind a verified purchase plan.

Commerce decisions can be traced through checks such as:

- catalog match,
- product approval,
- availability,
- budget,
- requested preferences,
- final verification.

## Bounded

AI operates inside application-controlled constraints.

The model cannot override:

- catalog truth,
- price,
- stock,
- availability,
- budget,
- cart state,
- payment amount.

## Gated

Merchant growth recommendations are not automatically executed.

For a generated product or variant, the merchant must review and approve the action and define its actual commerce information before it becomes sellable.

> **The final business decision stays with the merchant.**

---

# Lost Demand → Revenue Opportunity

A key SmartCart workflow is turning failed buying intent into an actionable merchant opportunity.

Example from the demo:

Customers repeatedly wanted a brownie around ₹200.

The merchant already had a **Brownie Box at ₹499**.

This showed that brownie demand existed, but the available product did not fit the customer's price requirement.

SmartCart classified the opportunity as:

**CREATE_VARIANT**

A smaller **Single Brownie** was proposed.

The merchant reviewed the opportunity and approved the product at ₹199.

A customer later purchased the Single Brownie through Razorpay test mode.

This creates an audit trail:

> **Customer demand → Merchant opportunity → Merchant action → Product → Paid order**

---

# Revenue Measurement

SmartCart connects products created through demand opportunities with completed paid orders.

This allows the merchant dashboard to show revenue associated with products originating from SmartCart opportunities.

The attribution is calculated from actual paid orders stored by the application.

It is **not an AI-generated revenue estimate**.

---

# Razorpay Integration

SmartCart uses **Razorpay Test Mode** for the payment flow.

Before checkout, the backend revalidates the cart against current commerce data.

The server determines:

- products,
- quantities,
- prices,
- currency,
- final payment amount.

The browser does not provide the authoritative payment amount.

After checkout, SmartCart verifies the Razorpay payment using server-side payment data and signature verification before recording the resulting order.

The order stores immutable item snapshots so historical paid-order information remains stable even if catalog data later changes.

---

# Catalog Ingestion

Merchants can add products through three ingestion paths.

### Manual Entry

Products can be added directly through the merchant interface.

### CSV / JSON Upload

Structured catalog files can be imported for merchant review.

### Website Crawl

SmartCart can discover product information from merchant websites.

Crawler protections include:

- HTTP/HTTPS URL validation,
- private-network and loopback blocking,
- redirect validation,
- bounded crawling,
- response-size limits,
- request timeouts,
- robots.txt handling.

Imported and crawled products remain subject to merchant approval before becoming buyer-visible.

---

# Growth Agent

SmartCart's merchant-side growth system uses recorded demand to identify possible actions.

Supported action families include:

- `CREATE_PRODUCT`
- `CREATE_VARIANT`
- `ADD_OPTION`
- `RESTOCK_PRODUCT`
- `INCREASE_STOCK`

The action family is selected using deterministic application rules based on the underlying demand condition.

AI can help explain or draft the recommendation, but it does not independently choose or execute the final commerce action.

---

# Failure Recovery

One issue encountered during development was **occasion-based product discovery**.

A customer could ask:

> "I need something special for my girlfriend's birthday."

Initially, abstract requests like this could be searched too literally, causing useful catalog products to be missed.

One possible solution would have been to let Gemini freely recommend products.

That was rejected because the model could then recommend something the merchant does not actually sell.

Instead, SmartCart changed the responsibility of the AI.

Gemini can translate an abstract occasion such as **birthday** into useful catalog searches such as **cake** or **celebration**.

However, every final recommendation must still come from the merchant's approved catalog.

This preserved catalog grounding while improving natural-language discovery.

---

# Architecture

```text
                         ┌─────────────────────┐
                         │      Customer       │
                         └──────────┬──────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ React + Vite        │
                         │ Buyer Experience    │
                         └──────────┬──────────┘
                                    │
                                    ▼
┌──────────────┐        ┌─────────────────────┐
│ Google       │◄──────►│ Node.js + Express   │
│ Gemini       │        │ Backend             │
└──────────────┘        └──────────┬──────────┘
                                    │
                  ┌─────────────────┼─────────────────┐
                  │                 │                 │
                  ▼                 ▼                 ▼
       ┌──────────────────┐ ┌──────────────┐ ┌────────────────┐
       │ Decision Engine  │ │ PostgreSQL   │ │ Razorpay       │
       │ Deterministic    │ │ + Prisma     │ │ Test Mode      │
       │ Commerce Logic   │ │              │ │                │
       └──────────────────┘ └──────┬───────┘ └────────────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │ Merchant Growth     │
                         │ & Demand System     │
                         └─────────────────────┘