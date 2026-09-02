/**
 * Curated vocabulary for deterministic skill / industry / role extraction.
 * Matching is word-boundary, case-insensitive and alias-aware ("nodejs" →
 * "Node.js"). Extend the lists freely; order does not matter.
 */
export interface SkillTerm {
  term: string;
  category: string;
  aliases?: string[];
}

const S = (category: string, ...items: (string | [string, string[]])[]): SkillTerm[] =>
  items.map((i) => (typeof i === "string" ? { term: i, category } : { term: i[0], category, aliases: i[1] }));

export const SKILLS: SkillTerm[] = [
  ...S("languages", "TypeScript", "JavaScript", "Python", "Java", "Go", ["C#", ["csharp", "c sharp"]], ["C++", ["cpp"]], "C", "Rust", "Ruby", "PHP", "Swift", "Kotlin", "Scala", "R", "MATLAB", "Perl", "Dart", "Elixir", "Haskell", "Objective-C", "Bash", "PowerShell", "SQL", "HTML", "CSS", "Sass", "GraphQL", "Solidity"),
  ...S("frameworks", "React", ["Node.js", ["nodejs", "node js", "node"]], ["Next.js", ["nextjs"]], ["Vue.js", ["vue", "vuejs"]], "Angular", "Svelte", "Express", "NestJS", "Django", "Flask", "FastAPI", "Spring", "Spring Boot", ["Ruby on Rails", ["rails"]], "Laravel", ".NET", "ASP.NET", "Flutter", "React Native", "SwiftUI", "Electron", "Tailwind CSS", "Bootstrap", "jQuery", "Redux", "Vite", "Webpack", "Jest", "Cypress", "Playwright", "Selenium", "Storybook"),
  ...S("cloud", "AWS", "Azure", ["Google Cloud", ["gcp", "google cloud platform"]], "Docker", "Kubernetes", "Terraform", "Ansible", "Helm", "Serverless", "Lambda", "Cloudflare", "Vercel", "Netlify", "Heroku", "Linux", "Nginx", "CI/CD", "GitHub Actions", "Jenkins", "GitLab CI", "CircleCI", "Datadog", "Grafana", "Prometheus", "Splunk", "New Relic", "Sentry", "Vault", "Istio", "OpenShift", "VMware"),
  ...S("data", ["PostgreSQL", ["postgres"]], "MySQL", "SQLite", "MongoDB", "Redis", "Elasticsearch", "Kafka", "RabbitMQ", "Spark", "Hadoop", "Snowflake", "BigQuery", "Redshift", "Databricks", "dbt", "Airflow", "Pandas", "NumPy", "scikit-learn", "TensorFlow", "PyTorch", "Keras", "Tableau", "Power BI", "Looker", "Excel", "Google Sheets", "Data Modeling", "ETL", "Data Warehousing", "Machine Learning", "Deep Learning", "NLP", "Computer Vision", "Statistics", "A/B Testing", "LLM", "Prompt Engineering", "RAG", "Ollama", "OpenAI API"),
  ...S("engineering", "REST APIs", "Microservices", "Distributed Systems", "System Design", "TDD", "Unit Testing", "Agile", "Scrum", "Kanban", "Git", "Code Review", "Performance Tuning", "Observability", "Security", "OAuth", "Accessibility", "Responsive Design", "Mobile Development", "Embedded Systems", "Firmware", "IoT", "Networking", "TCP/IP", "DNS", "Active Directory", "Windows Server", "macOS", "iOS", "Android"),
  ...S("design", "Figma", "Sketch", "Adobe XD", "Photoshop", "Illustrator", "InDesign", "After Effects", "Premiere Pro", "Canva", "UX Research", "UX Design", "UI Design", "Wireframing", "Prototyping", "Design Systems", "Typography", "Branding", "Motion Design", "3D Modeling", "Blender", "Procreate"),
  ...S("product", "Product Management", "Roadmapping", "User Stories", "Product Strategy", "Jira", "Confluence", "Asana", "Trello", "Notion", "Stakeholder Management", "Go-to-Market", "Market Research", "Competitive Analysis", "OKRs", "Requirements Gathering", "Product Analytics", "Mixpanel", "Amplitude", "Google Analytics"),
  ...S("marketing", "SEO", "SEM", "Content Marketing", "Email Marketing", "Copywriting", "Social Media", "Google Ads", "Meta Ads", "HubSpot", "Marketo", "Mailchimp", "Brand Management", "Growth Marketing", "Marketing Automation", "CRM", "Salesforce", "Public Relations", "Influencer Marketing", "Video Editing", "WordPress", "Shopify", "Etsy", "Print on Demand", "E-commerce"),
  ...S("sales", "Account Management", "Business Development", "Lead Generation", "Cold Outreach", "Negotiation", "Sales Enablement", "Customer Success", "Customer Support", "Zendesk", "Intercom", "Pipeline Management", "Quota Attainment", "SaaS Sales", "Enterprise Sales", "Onboarding", "Retention"),
  ...S("operations", "Project Management", "Program Management", "PMP", "Process Improvement", "Lean", "Six Sigma", "Supply Chain", "Logistics", "Procurement", "Inventory Management", "Vendor Management", "Operations Management", "Quality Assurance", "Compliance", "Risk Management", "Change Management", "Facilities", "Scheduling", "Training", "Recruiting", "Onboarding Programs", "HRIS", "Workday", "Payroll", "Benefits Administration", "Employee Relations"),
  ...S("finance", "Accounting", "Bookkeeping", "QuickBooks", "Xero", "Financial Analysis", "Financial Modeling", "Budgeting", "Forecasting", "GAAP", "Auditing", "Tax Preparation", "Accounts Payable", "Accounts Receivable", "CPA", "CFA", "Bloomberg", "Underwriting", "Fraud Analysis", "Anti-Money Laundering"),
  ...S("healthcare", "Patient Care", "EMR", "Epic", "Cerner", "HIPAA", "Medical Coding", "ICD-10", "Phlebotomy", "Clinical Research", "Nursing", "Telehealth", "Pharmacy", "Medical Billing", "Case Management", "Care Coordination", "BLS", "ACLS"),
  ...S("education", "Curriculum Development", "Instructional Design", "Lesson Planning", "Classroom Management", "E-learning", "LMS", "Moodle", "Canvas LMS", "Tutoring", "Teaching", "Assessment Design"),
  ...S("trades", "Electrical", "Plumbing", "HVAC", "Welding", "Carpentry", "CNC", "AutoCAD", "SolidWorks", "Revit", "Blueprint Reading", "OSHA", "Forklift", "CDL", "Maintenance", "Machining"),
  ...S("writing", "Technical Writing", "Editing", "Proofreading", "Documentation", "Grant Writing", "Journalism", "Content Strategy", "Localization", "Transcription", "Research", "Data Entry", "Customer Communication", "Public Speaking", "Presentation Skills"),
  ...S("spoken languages", "Spanish", "French", "German", "Portuguese", "Mandarin", "Japanese", "Korean", "Italian", "Arabic", "Hindi", "Russian", "Dutch", "ASL"),
  ...S("soft skills", "Leadership", "Mentoring", "Communication", "Collaboration", "Problem Solving", "Time Management", "Cross-functional", "Remote Work", "Attention to Detail", "Adaptability"),
];

export const INDUSTRIES: string[] = [
  "SaaS", "Fintech", "Healthcare", "Biotech", "Pharmaceutical", "E-commerce", "Retail", "Logistics", "Manufacturing", "Automotive", "Aerospace", "Defense", "Higher Education", "EdTech", "Nonprofit", "Government", "Media", "Entertainment", "Gaming", "Advertising", "Marketing Agency", "Consulting", "Insurance", "Banking", "Real Estate", "Construction", "Hospitality", "Travel", "Energy", "Utilities", "Telecommunications", "Cybersecurity", "Legal", "Human Resources", "Staffing", "Sports", "Fitness", "Food and Beverage", "Agriculture", "Print on Demand", "Fashion", "Publishing",
];

export const ROLE_TITLES: string[] = [
  "Software Engineer", "Senior Software Engineer", "Staff Engineer", "Software Developer", "Frontend Engineer", "Front-End Developer", "Backend Engineer", "Back-End Developer", "Full Stack Engineer", "Full-Stack Developer", "Web Developer", "Mobile Developer", "iOS Developer", "Android Developer", "DevOps Engineer", "Site Reliability Engineer", "Platform Engineer", "Cloud Engineer", "Data Engineer", "Data Scientist", "Data Analyst", "Business Analyst", "Machine Learning Engineer", "AI Engineer", "Analytics Engineer", "QA Engineer", "Test Engineer", "Security Engineer", "Systems Administrator", "Network Engineer", "IT Support Specialist", "Help Desk Technician", "Solutions Architect", "Software Architect", "Engineering Manager", "Technical Lead", "Tech Lead", "CTO",
  "Product Manager", "Senior Product Manager", "Product Owner", "Program Manager", "Project Manager", "Scrum Master", "Product Designer", "UX Designer", "UI Designer", "UX Researcher", "Graphic Designer", "Visual Designer", "Brand Designer", "Motion Designer", "Art Director", "Creative Director", "Illustrator", "Video Editor", "Content Creator",
  "Marketing Manager", "Digital Marketing Manager", "Content Marketing Manager", "SEO Specialist", "Social Media Manager", "Growth Manager", "Marketing Coordinator", "Copywriter", "Content Writer", "Technical Writer", "Editor", "Communications Manager", "Public Relations Specialist", "Community Manager",
  "Account Executive", "Sales Development Representative", "Business Development Representative", "Account Manager", "Customer Success Manager", "Customer Support Specialist", "Customer Service Representative", "Sales Manager", "Solutions Engineer", "Sales Engineer",
  "Operations Manager", "Operations Coordinator", "Office Manager", "Executive Assistant", "Administrative Assistant", "Virtual Assistant", "Recruiter", "Technical Recruiter", "HR Manager", "HR Generalist", "People Operations", "Talent Acquisition Specialist", "Training Specialist",
  "Accountant", "Bookkeeper", "Financial Analyst", "Controller", "Finance Manager", "Auditor", "Payroll Specialist", "Underwriter",
  "Registered Nurse", "Nurse Practitioner", "Medical Assistant", "Medical Coder", "Medical Biller", "Pharmacist", "Clinical Research Coordinator", "Case Manager", "Therapist", "Counselor",
  "Teacher", "Instructor", "Instructional Designer", "Curriculum Developer", "Tutor", "Professor",
  "Electrician", "Plumber", "HVAC Technician", "Mechanic", "Machinist", "Welder", "CAD Designer", "Project Engineer", "Civil Engineer", "Mechanical Engineer", "Electrical Engineer", "Industrial Engineer",
  "Data Entry Clerk", "Transcriptionist", "Translator", "Paralegal", "Legal Assistant", "Researcher", "Consultant", "Founder", "General Manager", "Director", "Vice President",
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary-safe pattern that tolerates "node.js"/"node js" and "c++"/"c#". */
function termPattern(term: string): RegExp {
  const body = escapeRe(term).replace(/\\\./g, "[.\\s]?").replace(/\\\s|\s/g, "[\\s-]");
  // Very short terms ("Go", "R", "C") must stand alone: no letters, digits, hyphens or dots around them.
  const short = term.length <= 2;
  const leading = /^[a-z0-9]/i.test(term) ? (short ? "(?<![a-z0-9.+#-])" : "(?<![a-z0-9])") : "(?<![^\\s(,;/])";
  const trailing = /[a-z0-9]$/i.test(term) ? (short ? "(?![a-z0-9.+#-])" : "(?![a-z0-9])") : "(?![^\\s),;/.])";
  return new RegExp(`${leading}${body}${trailing}`, "i");
}

interface Compiled {
  term: string;
  patterns: RegExp[];
}

let compiledSkills: Compiled[] | null = null;
let compiledIndustries: Compiled[] | null = null;
let compiledRoles: Compiled[] | null = null;

function compile(list: { term: string; aliases?: string[] }[]): Compiled[] {
  return list.map((s) => ({ term: s.term, patterns: [s.term, ...(s.aliases ?? [])].map(termPattern) }));
}

function findTerms(text: string, compiled: Compiled[], max: number): string[] {
  const hits: { term: string; index: number; end: number }[] = [];
  for (const c of compiled) {
    let best: { index: number; end: number } | null = null;
    for (const re of c.patterns) {
      const m = re.exec(text);
      if (m && (!best || m.index < best.index)) best = { index: m.index, end: m.index + m[0].length };
    }
    if (best) hits.push({ term: c.term, ...best });
  }
  // A shorter term wholly inside a longer matched term ("Research" in "Market Research") is dropped.
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.index <= h.index && o.end >= h.end && o.end - o.index > h.end - h.index));
  kept.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of kept) {
    const key = h.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h.term);
    if (out.length >= max) break;
  }
  return out;
}

export function findSkills(text: string, max = 80): string[] {
  if (!text) return [];
  compiledSkills ??= compile(SKILLS);
  return findTerms(text, compiledSkills, max);
}

export function findIndustries(text: string, max = 15): string[] {
  if (!text) return [];
  compiledIndustries ??= compile(INDUSTRIES.map((term) => ({ term })));
  return findTerms(text, compiledIndustries, max);
}

export function findRoleTitles(text: string, max = 10): string[] {
  if (!text) return [];
  compiledRoles ??= compile(ROLE_TITLES.map((term) => ({ term })));
  return findTerms(text, compiledRoles, max);
}
