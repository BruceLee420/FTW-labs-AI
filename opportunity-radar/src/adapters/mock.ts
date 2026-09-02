/** Fixture-backed adapter for demos and tests. No network. */
import type { AdapterFetchResult, AtsAdapter } from "./types.ts";
import type { ManualOpportunityInput } from "../schemas/opportunity.ts";

export const MOCK_LISTINGS: ManualOpportunityInput[] = [
  {
    companyName: "Northwind Analytics",
    title: "Senior Software Engineer (Remote)",
    sourceName: "mock:sample",
    sourceType: "OFFICIAL_ATS",
    sourceUrl: "https://boards.greenhouse.io/northwindanalytics/jobs/4010001",
    applicationUrl: "https://boards.greenhouse.io/northwindanalytics/jobs/4010001",
    externalId: "4010001",
    companyWebsite: "https://northwind.example",
    officialCareerUrl: "https://northwind.example/careers",
    locationText: "Remote - United States",
    rawDescription: [
      "About the role",
      "Northwind Analytics builds data tooling for logistics teams. This is a fully remote role open to candidates located in the United States.",
      "Responsibilities",
      "- Design and ship TypeScript services on Node.js backed by PostgreSQL",
      "- Own reliability and observability for production systems on AWS",
      "- Mentor engineers and lead design reviews",
      "Requirements",
      "- 5+ years building production web services",
      "- Strong TypeScript and Node.js experience",
      "- Experience with PostgreSQL, Docker and AWS",
      "Nice to have",
      "- Kubernetes and Terraform",
      "Compensation: $150,000 - $185,000 per year.",
      "Our interview process has three stages. Northwind Analytics is an equal opportunity employer. Contact recruiting@northwind.example.",
    ].join("\n"),
    evaluate: true,
  },
  {
    companyName: "Contoso Freight",
    title: "Product Manager, Logistics Platform",
    sourceName: "mock:sample",
    sourceType: "JOB_BOARD",
    sourceUrl: "https://jobs.lever.co/contosofreight/8b1c2d3e",
    applicationUrl: "https://jobs.lever.co/contosofreight/8b1c2d3e",
    externalId: "8b1c2d3e",
    companyWebsite: "https://contosofreight.example",
    locationText: "Hybrid - Austin, TX",
    rawDescription: [
      "About the role",
      "You will own the roadmap for our carrier-facing platform. Hybrid: two days per week in our Austin office. Candidates must reside in Texas, Colorado or Arizona.",
      "Responsibilities",
      "- Define product strategy and quarterly OKRs with engineering and design",
      "- Run discovery with carriers and shippers; write user stories in Jira",
      "- Partner with marketing on go-to-market plans",
      "Requirements",
      "- 4+ years of product management experience in SaaS or logistics",
      "- Strong stakeholder management and analytical skills (SQL, Amplitude)",
      "- Experience shipping B2B platforms",
      "Salary range $140k–$165k plus bonus. Interview process: recruiter screen, hiring manager, panel.",
    ].join("\n"),
    evaluate: true,
  },
  {
    companyName: "Global Payments Solutions",
    title: "Data Entry Clerk - Work From Home - Immediate Start",
    sourceName: "mock:sample",
    sourceType: "JOB_BOARD",
    sourceUrl: "https://bit.ly/3abcdef",
    applicationUrl: "https://bit.ly/3abcdef",
    locationText: "Remote",
    rawDescription: [
      "Urgent hiring! Start today, no interview needed. Earn $500 per day from home.",
      "To get started you must purchase a starter equipment kit with gift cards and send the codes to our HR on Telegram @gps_hr.",
      "Send your SSN and bank account details to gpshiring@gmail.com to process your first payment.",
    ].join("\n"),
    evaluate: true,
  },
];

export class MockAdapter implements AtsAdapter {
  readonly id = "mock";
  readonly displayName = "Mock ATS (fixtures)";
  readonly policyNote = "Synthetic data for demos and tests; no network access.";
  readonly targetHint = '"sample" (three synthetic listings) or "empty"';

  validateTarget(target: string): string | null {
    return target === "sample" || target === "empty" ? null : 'Mock targets are "sample" or "empty".';
  }

  async fetch(target: string): Promise<AdapterFetchResult> {
    const problem = this.validateTarget(target);
    if (problem) throw new Error(problem);
    return { sourceName: `mock:${target}`, items: target === "sample" ? MOCK_LISTINGS.map((l) => ({ ...l })) : [], warnings: [] };
  }
}
