/**
 * Job application actions — LinkedIn Easy Apply automation.
 *
 * LinkedIn's Easy Apply flow is a multi-step modal wizard. This module:
 *   1. Opens the job posting URL.
 *   2. Clicks the "Easy Apply" button (bails out with `not_easy_apply` when
 *      the job only has an external "Apply" link).
 *   3. Iterates through each modal step, advancing via "Next" / "Continue" /
 *      "Review" buttons. On text/select/radio screening questions it uses
 *      caller-supplied answers or sensible defaults.
 *   4. Clicks "Submit application" on the final review step.
 *   5. Returns a structured result with outcome, step reached, and any
 *      actionable error message.
 *
 * Design notes:
 *   - LinkedIn's modal uses obfuscated class names that rotate between deploys.
 *     All selectors anchor on stable ARIA attributes and semantic HTML.
 *   - We cap iteration at MAX_STEPS to guard against pathological forms and
 *     never loop forever.
 *   - Write actions are paced with rateLimitDelay() to respect LinkedIn's
 *     anti-automation signals.
 */

import type { Locator, Page } from 'playwright';

import {
  LINKEDIN_BASE,
  assertAuthenticated,
  navigate,
  rateLimitDelay,
  sleep,
} from './common';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Caller-supplied answers to screening questions, keyed by question text. */
export type ScreeningAnswers = Record<string, string>;

export interface ApplyJobOptions {
  /** Extra answers to inject into the Easy Apply form, keyed by question label. */
  screeningAnswers?: ScreeningAnswers;
  /**
   * Resume file to upload if the form requests one. Must be an absolute path
   * on the local filesystem. If omitted, the form uses the default uploaded
   * LinkedIn resume.
   */
  resumePath?: string;
  /**
   * When true the application is NOT submitted — the wizard is stepped through
   * but the final "Submit" click is skipped. Useful for testing.
   */
  dryRun?: boolean;
}

export interface ApplyJobResult {
  success: boolean;
  /**
   * Outcome classification:
   *  - 'submitted'        application submitted (or dry-run complete)
   *  - 'not_easy_apply'  job only has an external Apply link
   *  - 'already_applied' already applied to this role
   *  - 'failed'          wizard could not be completed
   */
  outcome:
    | 'submitted'
    | 'not_easy_apply'
    | 'already_applied'
    | 'failed';
  /** Which step (1-based) the wizard reached before finishing or failing. */
  stepsCompleted: number;
  message: string;
}

export interface RecommendedJob {
  title?: string;
  company?: string;
  location?: string;
  jobUrl: string;
  easyApply: boolean;
  postedDate?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Guard against infinite loops on unexpectedly long forms. */
const MAX_STEPS = 12;

/** How long to wait (ms) after each modal-step transition. */
const STEP_DELAY_MS = 1200;

// ---------------------------------------------------------------------------
// Selector helpers
// ---------------------------------------------------------------------------

/**
 * Selectors tried IN ORDER for the "Easy Apply" trigger button on a job page.
 * LinkedIn renders this as either a <button> or an <a> depending on device
 * and A/B variant.
 */
const EASY_APPLY_SELECTORS = [
  'button[aria-label*="Easy Apply"]',
  'button:has-text("Easy Apply")',
  'a[aria-label*="Easy Apply"]',
  '.jobs-apply-button--top-card button',
];

/** Selectors for the "Next" / "Continue" / "Review" advancement button. */
const NEXT_BTN_SELECTORS = [
  'button[aria-label="Continue to next step"]',
  'button[aria-label="Review your application"]',
  'button:has-text("Review")',
  'button:has-text("Next")',
  'button:has-text("Continue")',
];

/** Selectors for the final "Submit application" button. */
const SUBMIT_BTN_SELECTORS = [
  'button[aria-label="Submit application"]',
  'button:has-text("Submit application")',
  'button:has-text("Submit")',
];

/** Selectors for the modal "Dismiss" / close button (to abort on failure). */
const DISMISS_BTN_SELECTORS = [
  'button[aria-label="Dismiss"]',
  'button[aria-label="Close"]',
  'button[data-test-modal-close-btn]',
];

// ---------------------------------------------------------------------------
// JobActions
// ---------------------------------------------------------------------------

export class JobActions {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // -------------------------------------------------------------------------
  // applyToJob
  // -------------------------------------------------------------------------

  async applyToJob(
    jobUrl: string,
    opts: ApplyJobOptions = {},
  ): Promise<ApplyJobResult> {
    const url = this.normalizeJobUrl(jobUrl);
    await navigate(this.page, url);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    // Already applied? LinkedIn shows a "Applied" badge on the top card.
    const alreadyApplied =
      (await this.page
        .locator(
          '.jobs-details-top-card__apply-error, ' +
            '[aria-label*="Applied"], ' +
            'span:has-text("Applied")',
        )
        .count()) > 0;
    if (alreadyApplied) {
      return {
        success: false,
        outcome: 'already_applied',
        stepsCompleted: 0,
        message: 'You have already applied to this job.',
      };
    }

    // Find the Easy Apply button.
    const easyApplyBtn = await this.findFirst(EASY_APPLY_SELECTORS);
    if (!easyApplyBtn) {
      // Check if there is an external Apply button instead.
      const externalApply =
        (await this.page
          .locator('button:has-text("Apply"), a:has-text("Apply")')
          .count()) > 0;
      return {
        success: false,
        outcome: 'not_easy_apply',
        stepsCompleted: 0,
        message: externalApply
          ? 'This job requires an external application — no Easy Apply button available.'
          : 'No Apply button found on this job posting.',
      };
    }

    await rateLimitDelay();
    await easyApplyBtn.click();
    await sleep(STEP_DELAY_MS);

    // Step through the wizard.
    let stepsCompleted = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      // Check if the Submit button is now visible — means we are on the final step.
      const submitBtn = await this.findFirst(SUBMIT_BTN_SELECTORS);
      if (submitBtn) {
        if (opts.dryRun) {
          await this.dismiss();
          return {
            success: true,
            outcome: 'submitted',
            stepsCompleted,
            message: `Dry run complete — reached the final review step after ${stepsCompleted} step(s). Application was NOT submitted.`,
          };
        }
        await rateLimitDelay();
        await submitBtn.click();
        await sleep(STEP_DELAY_MS);
        stepsCompleted++;

        // Confirm submission — LinkedIn shows a "Application submitted" heading.
        const confirmed =
          (await this.page
            .locator(
              '[aria-label*="Application submitted"], ' +
                'h2:has-text("Application submitted"), ' +
                'h3:has-text("Application submitted")',
            )
            .count()) > 0;

        await this.dismiss().catch(() => undefined);
        return {
          success: confirmed,
          outcome: 'submitted',
          stepsCompleted,
          message: confirmed
            ? 'Application submitted successfully.'
            : 'Submit was clicked but confirmation was not detected — the application may have been submitted.',
        };
      }

      // Handle any inputs on the current step before advancing.
      await this.fillCurrentStep(opts.screeningAnswers ?? {}, opts.resumePath);

      // Advance to the next step.
      const nextBtn = await this.findFirst(NEXT_BTN_SELECTORS);
      if (!nextBtn) {
        await this.dismiss().catch(() => undefined);
        return {
          success: false,
          outcome: 'failed',
          stepsCompleted,
          message: `Could not find Next/Continue button on step ${step + 1}. The form may have required fields that need manual input.`,
        };
      }

      await rateLimitDelay();
      await nextBtn.click();
      await sleep(STEP_DELAY_MS);
      stepsCompleted++;

      // If an error message appeared (required field not filled), bail.
      const hasError =
        (await this.page
          .locator(
            '.artdeco-inline-feedback--error, ' +
              '[aria-live="assertive"]:not(:empty), ' +
              '.fb-form-element__error-text',
          )
          .count()) > 0;
      if (hasError) {
        await this.dismiss().catch(() => undefined);
        return {
          success: false,
          outcome: 'failed',
          stepsCompleted,
          message:
            `Validation error on step ${stepsCompleted}. Provide additional answers via the ` +
            '`screeningAnswers` parameter (keys = question label text, values = your answer).',
        };
      }
    }

    await this.dismiss().catch(() => undefined);
    return {
      success: false,
      outcome: 'failed',
      stepsCompleted,
      message: `Reached the maximum step limit (${MAX_STEPS}) without completing the application.`,
    };
  }

  // -------------------------------------------------------------------------
  // getRecommendedJobs
  // -------------------------------------------------------------------------

  /**
   * Fetches job recommendations from the LinkedIn Jobs homepage.
   *
   * Navigates to `/jobs/` and scrapes the "Recommended for you" / "Jobs you
   * may be interested in" section. Returns normalized job cards with title,
   * company, location, jobUrl, easyApply flag, and posted date.
   */
  async getRecommendedJobs(limit = 10): Promise<RecommendedJob[]> {
    await navigate(this.page, `${LINKEDIN_BASE}/jobs/`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    await sleep(2000);

    const raw = await this.page.evaluate((cap) => {
      const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
      const ACTIVITY_RE = /\/jobs\/view\/(\d+)/;
      const seen = new Set<string>();
      const out: Array<{ href: string; lines: string[] }> = [];

      // Job cards on the jobs homepage link to /jobs/view/<id>/.
      const anchors = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href ?? '';
        const m = href.match(ACTIVITY_RE);
        const id = m?.[1] ?? '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const card = a.closest('li') ?? a.closest('article') ?? a.parentElement;
        if (!card) continue;
        const stop = new Set<string>();
        const lines = ((card as HTMLElement).innerText ?? '')
          .split('\n')
          .map(norm)
          .filter((t) => { if (!t || stop.has(t)) return false; stop.add(t); return true; });
        out.push({ href, lines });
        if (out.length >= cap) break;
      }
      return out;
    }, limit);

    const TIME_RE = /\b(ago|hour|day|week|month|minute)s?\b|just now/i;
    return raw
      .map((r): RecommendedJob | null => {
        const url = r.href.split('?')[0];
        if (!url) return null;
        const easyApply = r.lines.some((l) => /easy apply/i.test(l));
        const title = r.lines[0];
        const company = r.lines[1];
        const location = r.lines.slice(2).find((l) => /,/.test(l) || /remote|hybrid|on.?site/i.test(l));
        const postedDate = r.lines.find((l) => TIME_RE.test(l));
        const job: RecommendedJob = { jobUrl: url ?? '', easyApply };
        if (title) job.title = title;
        if (company) job.company = company;
        if (location) job.location = location;
        if (postedDate) job.postedDate = postedDate;
        return job;
      })
      .filter((j): j is RecommendedJob => j !== null);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Try each selector in order and return the first visible locator found,
   * or null if none match.
   */
  private async findFirst(selectors: string[]): Promise<Locator | null> {
    for (const sel of selectors) {
      const loc = this.page.locator(sel).first();
      try {
        if ((await loc.count()) > 0 && (await loc.isVisible())) {
          return loc;
        }
      } catch {
        // selector not found or not attached — try next
      }
    }
    return null;
  }

  /**
   * Fill inputs on the current wizard step.
   *
   * For each labeled input we look up the label text in `answers`. If no
   * answer is provided we use conservative defaults:
   *   - checkboxes: leave unchecked
   *   - radio groups: pick the first option
   *   - text inputs: leave empty (LinkedIn often pre-fills from the profile)
   *   - selects: leave at default
   */
  private async fillCurrentStep(
    answers: ScreeningAnswers,
    resumePath?: string,
  ): Promise<void> {
    // Resume upload — only attempt when a path was supplied and the file input
    // is visible.
    if (resumePath) {
      const fileInput = this.page
        .locator('input[type="file"][accept*="pdf"], input[type="file"][accept*="doc"]')
        .first();
      if ((await fileInput.count()) > 0) {
        await fileInput.setInputFiles(resumePath).catch(() => undefined);
        await sleep(800);
      }
    }

    // Text inputs: fill from answers map keyed by the associated label text.
    const textInputs = this.page.locator(
      'input[type="text"]:visible, input[type="number"]:visible, textarea:visible',
    );
    const textCount = await textInputs.count();
    for (let i = 0; i < textCount; i++) {
      const input = textInputs.nth(i);
      const id = await input.getAttribute('id').catch(() => null);
      const label = id
        ? await this.page
            .locator(`label[for="${id}"]`)
            .first()
            .textContent()
            .catch(() => null)
        : null;

      const labelKey = label?.replace(/\s+/g, ' ').trim() ?? '';
      const answer = this.lookupAnswer(answers, labelKey);

      // Only fill if we have a caller-supplied answer and the field is empty.
      if (answer) {
        const current = await input.inputValue().catch(() => '');
        if (!current) {
          await input.fill(answer).catch(() => undefined);
          await sleep(300);
        }
      }
    }

    // Select dropdowns: fill from answers map.
    const selects = this.page.locator('select:visible');
    const selectCount = await selects.count();
    for (let i = 0; i < selectCount; i++) {
      const sel = selects.nth(i);
      const id = await sel.getAttribute('id').catch(() => null);
      const label = id
        ? await this.page
            .locator(`label[for="${id}"]`)
            .first()
            .textContent()
            .catch(() => null)
        : null;
      const labelKey = label?.replace(/\s+/g, ' ').trim() ?? '';
      const answer = this.lookupAnswer(answers, labelKey);
      if (answer) {
        await sel.selectOption({ label: answer }).catch(() =>
          sel.selectOption({ value: answer }).catch(() => undefined),
        );
        await sleep(300);
      }
    }

    // Radio groups: select first option when no answer supplied (avoids
    // required-field errors on yes/no questions).
    const radioGroups = await this.page
      .locator('fieldset:visible')
      .evaluateAll((fieldsets) =>
        fieldsets.map((fs) => ({
          legend: (fs.querySelector('legend')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
          name: (fs.querySelector('input[type="radio"]') as HTMLInputElement | null)?.name ?? '',
        })),
      );
    for (const { legend, name } of radioGroups) {
      if (!name) continue;
      const answer = this.lookupAnswer(answers, legend);
      const selector = answer
        ? `input[type="radio"][name="${name}"][value="${answer}"]`
        : `input[type="radio"][name="${name}"]`;
      const radio = this.page.locator(selector).first();
      if ((await radio.count()) > 0) {
        await radio.check().catch(() => undefined);
        await sleep(200);
      }
    }
  }

  /**
   * Case-insensitive partial-match lookup against the answers map.
   * Returns the first value whose key appears as a substring of `label`,
   * or vice versa.
   */
  private lookupAnswer(
    answers: ScreeningAnswers,
    label: string,
  ): string | undefined {
    if (!label) return undefined;
    const hay = label.toLowerCase();
    for (const [key, value] of Object.entries(answers)) {
      const needle = key.toLowerCase();
      if (hay.includes(needle) || needle.includes(hay)) return value;
    }
    return undefined;
  }

  /** Dismiss the Easy Apply modal via its close button (best-effort). */
  private async dismiss(): Promise<void> {
    const btn = await this.findFirst(DISMISS_BTN_SELECTORS);
    if (!btn) return;
    await btn.click().catch(() => undefined);
    await sleep(600);
    // Confirm the "Discard application?" dialog if it appears.
    const discardBtn = this.page
      .locator(
        'button[data-control-name="discard_application_confirm_btn"], ' +
          'button:has-text("Discard")',
      )
      .first();
    if ((await discardBtn.count()) > 0) {
      await discardBtn.click().catch(() => undefined);
      await sleep(500);
    }
  }

  /** Normalize a job reference to a full LinkedIn URL. */
  private normalizeJobUrl(input: string): string {
    if (/^https?:\/\//i.test(input)) return input;
    const clean = input.replace(/^\/+/, '');
    return `${LINKEDIN_BASE}/${clean}`;
  }
}
