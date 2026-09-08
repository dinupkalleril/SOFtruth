/**
 * What an agent produces after actually using a product.
 *
 * The shape here is the whole idea: an agent signs up, uses the thing, and writes
 * about the experience for other agents. Not a checklist result. An account.
 *
 * Two layers, deliberately separated:
 *
 *   EVIDENCE  — what demonstrably happened. HTTP statuses, screenshots, timings,
 *               whether a verification email actually landed in a mailbox we own.
 *               A vendor cannot alter this by putting text on a page.
 *
 *   ACCOUNT   — what the agent concluded, in its own words, written for other
 *               agents to read. This is the thing a reader actually wants, and it
 *               is also the thing a hostile vendor could try to manipulate by
 *               hiding instructions in page content.
 *
 * Publishing both, clearly labelled, is what lets a reader trust the account as
 * far as the evidence supports it and no further. Collapsing them into a single
 * verdict is what removed the agent from this product the first time around.
 */

/** One thing the agent did, and what came back. Factual, not interpreted. */
export interface EvidenceStep {
  /** Sequence number within the session. */
  index: number;
  /** What the agent was trying to do, e.g. "submit signup form". */
  intent: string;
  /** Where it happened. */
  url: string;
  /** What actually happened, observed rather than judged. */
  observed: {
    httpStatus?: number;
    /** Page title after the action, if the page changed. */
    pageTitle?: string;
    /** Screenshot filename, relative to the session directory. */
    screenshot?: string;
    /** Anything the agent typed, with secrets already redacted. */
    input?: Record<string, string>;
    /** Error text surfaced by the product, verbatim. */
    errorText?: string;
  };
  startedAt: string;
  elapsedMs: number;
}

/**
 * A fact we can check without believing anybody: did a verification email
 * actually arrive in a mailbox SOFtruth controls?
 *
 * This is the anchor of the whole evidence layer. Page content can lie; an email
 * either landed in our inbox or it did not.
 */
export interface EmailEvidence {
  /** Address the agent gave the product, at a domain we own. */
  address: string;
  /** Unique string we searched for. */
  nonce: string;
  arrived: boolean;
  /** Seconds from the signup submission to arrival. */
  secondsToArrive?: number;
  /** Present when arrived: the subject line as received. */
  subject?: string;
  /** Set when OUR inbox was unreachable, which is not the product's fault. */
  inboxUnavailable?: string;
}

/**
 * Why an agent could not get further, when it could not.
 *
 * Structured rather than buried in prose because "we could not evaluate this" is
 * a completely different claim from "this product is bad", and a reader must not
 * confuse them. It is also a measurement in its own right: as more buying
 * decisions route through agents, whether a product can be evaluated by one at
 * all becomes a real product attribute, and this is the taxonomy of what stops
 * them.
 */
export type Blocker =
  /** A card was required before the core feature could be reached. */
  | "payment-required"
  /** Signup demanded a phone number or SMS code. */
  | "phone-verification"
  /** Access needed a human to approve, a demo call, or a waitlist. */
  | "manual-approval"
  /** A CAPTCHA or bot check the agent could not pass. */
  | "bot-check"
  /** The product is not usable in a browser (mobile app, Telegram, desktop). */
  | "not-web"
  /** Something else; blockedDetail says what. */
  | "other";

/**
 * The agent's own account, written for other agents.
 *
 * Prose is deliberate. The original idea was that an agent writes about the
 * product so other agents can read it, and a scoring rubric is not writing.
 */
export interface AgentAccount {
  /** Could the agent get in and use the thing at all? */
  couldSignUp: boolean;
  couldUseCoreFeature: boolean;
  /** Set when something stopped the agent before it could finish evaluating. */
  blockedBy?: Blocker | null;
  /** What exactly was demanded, in the agent's words. */
  blockedDetail?: string;
  /** What the product appears to actually do, in the agent's words. */
  whatItDoes: string;
  /** How getting started went. Friction, dead ends, surprises. */
  gettingStarted: string;
  /** What worked. Specific, referencing what it actually did. */
  worked: string[];
  /** What did not, or what got in the way. */
  didNotWork: string[];
  /** Claims the product made that the agent could not verify by using it. */
  unverifiedClaims: string[];
  /** The thing another agent most needs to know before recommending this. */
  bottomLine: string;
  /**
   * The agent's own confidence in its account, 1-10, and why. An agent that
   * could not complete signup should say so rather than infer from marketing.
   */
  confidence: number;
  confidenceReason: string;
}

/** One complete session: an agent used a product and wrote about it. */
export interface ExplorationRecord {
  schemaVersion: "softruth/exploration/v1";
  product: {
    slug: string;
    name: string;
    url: string;
  };
  /** Published so the run can be repeated with the same generated identity. */
  seed: string;
  /** The mailbox domain in effect, without which the seed does not reproduce. */
  inboxDomain: string;
  startedAt: string;
  finishedAt: string;

  /** What demonstrably happened. Not the agent's opinion. */
  evidence: {
    steps: EvidenceStep[];
    email: EmailEvidence;
    /** Total wall clock for the session. */
    totalSeconds: number;
  };

  /** What the agent concluded. Its words, clearly separated from the evidence. */
  account: AgentAccount;

  /**
   * The model that wrote the account. A reader deserves to know which agent's
   * experience this is, the same way a human review carries a byline.
   */
  agent: {
    model: string;
    /** Whether the agent could see page content that might carry injected text. */
    readPageContent: boolean;
  };

  /** Filled by CI. Absent means locally produced, therefore not evidence. */
  provenance?: {
    workflowRunUrl: string;
    commit: string;
    artifactDigest: string;
  };
}
