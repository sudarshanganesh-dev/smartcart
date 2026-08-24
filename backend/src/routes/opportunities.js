import { Router } from "express";
import {
  listOpportunitiesForMerchant,
  getOpportunityForMerchant,
  dismissOpportunity,
  generateDraftForOpportunity,
} from "../lib/intelligence/opportunityService.js";
import { generateDraftLimiter } from "../lib/rateLimit.js";

const STATUS_VALUES = ["OPEN", "ACTIONED", "DISMISSED"];

export const opportunitiesRouter = Router({ mergeParams: true });

opportunitiesRouter.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    if (status && !STATUS_VALUES.includes(status)) {
      return res.status(400).json({ error: "INVALID_STATUS_FILTER" });
    }
    const opportunities = await listOpportunitiesForMerchant({ merchantId: req.merchant.id, status });
    res.json(opportunities);
  } catch (error) {
    console.error("[opportunities] list failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

opportunitiesRouter.get("/:opportunityId", async (req, res) => {
  try {
    const opportunity = await getOpportunityForMerchant({ merchantId: req.merchant.id, opportunityId: req.params.opportunityId });
    if (!opportunity) {
      return res.status(404).json({ error: "OPPORTUNITY_NOT_FOUND" });
    }
    res.json(opportunity);
  } catch (error) {
    console.error("[opportunities] detail failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

opportunitiesRouter.post("/:opportunityId/dismiss", async (req, res) => {
  try {
    const result = await dismissOpportunity({ merchantId: req.merchant.id, opportunityId: req.params.opportunityId });
    if (result.error === "OPPORTUNITY_NOT_FOUND") {
      return res.status(404).json({ error: "OPPORTUNITY_NOT_FOUND" });
    }
    if (result.error === "OPPORTUNITY_NOT_OPEN") {
      return res.status(409).json({ error: "OPPORTUNITY_NOT_OPEN" });
    }
    res.json(result.opportunity);
  } catch (error) {
    console.error("[opportunities] dismiss failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});

opportunitiesRouter.post("/:opportunityId/generate-draft", generateDraftLimiter, async (req, res) => {
  try {
    const result = await generateDraftForOpportunity({ merchantId: req.merchant.id, opportunityId: req.params.opportunityId });
    if (result.error === "OPPORTUNITY_NOT_FOUND") {
      return res.status(404).json({ error: "OPPORTUNITY_NOT_FOUND" });
    }
    if (result.error === "OPPORTUNITY_NOT_OPEN") {
      return res.status(409).json({ error: "OPPORTUNITY_NOT_OPEN" });
    }
    if (result.error === "OPPORTUNITY_NOT_ACTIONABLE") {
      return res.status(409).json({ error: "OPPORTUNITY_NOT_ACTIONABLE" });
    }
    if (result.error === "MERCHANDISING_PROPOSAL_INVALID") {
      return res.status(502).json({ error: "MERCHANDISING_PROPOSAL_INVALID", details: result.details });
    }
    res.status(201).json(result.product);
  } catch (error) {
    console.error("[opportunities] generate-draft failed:", error.message);
    res.status(500).json({ error: "INTERNAL_ERROR" });
  }
});
