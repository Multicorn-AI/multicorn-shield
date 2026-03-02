#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface EmailCategory {
  name: string;
  count: number;
  senders: { name: string; email: string }[];
  subjectTemplates: string[];
  bodyTemplates: string[];
}

const categories: EmailCategory[] = [
  {
    name: "critical-work",
    count: 30,
    senders: [
      { name: "Sarah Mitchell", email: "sarah.mitchell@acmecorp.com" },
      { name: "David Chen", email: "dchen@techstart.io" },
      { name: "Emily Rodriguez", email: "emily.r@designco.com" },
      { name: "James Park", email: "jpark@financegroup.net" },
      { name: "Lisa Thompson", email: "lthompson@consulting.biz" },
    ],
    subjectTemplates: [
      "Q3 budget review - action needed",
      "Urgent: Client meeting moved to tomorrow",
      "Deadline approaching: Project Alpha deliverables",
      "Review required: Contract terms",
      "Action item: Team restructuring proposal",
      "Critical: Security audit findings",
      "Immediate: Board presentation prep",
      "Review needed: Quarterly report draft",
    ],
    bodyTemplates: [
      "Please review the attached document before Friday. The finance team needs sign-off by end of week.",
      "We need to discuss this in detail. Can we schedule a call this afternoon?",
      "This requires your immediate attention. The deadline is tight and we need your approval.",
      "I need your feedback on this before we proceed. Let me know if you have any concerns.",
      "This is time-sensitive. Please review and respond by end of day.",
    ],
  },
  {
    name: "personal-important",
    count: 30,
    senders: [
      { name: "Mom", email: "mom@family.com" },
      { name: "Dad", email: "dad@family.com" },
      { name: "Emma Wilson", email: "emma.wilson@email.com" },
      { name: "Michael Brown", email: "mike.brown@email.com" },
      { name: "Sophie Martinez", email: "sophie.m@email.com" },
    ],
    subjectTemplates: [
      "Dinner plans this weekend?",
      "Family gathering next month",
      "Travel plans for summer",
      "Doctor appointment reminder",
      "Birthday party invitation",
      "Holiday plans discussion",
      "Catching up soon?",
      "Important family update",
    ],
    bodyTemplates: [
      "Hey, are you free this weekend? I was thinking we could grab dinner and catch up.",
      "Just wanted to check in and see how you are doing. It has been a while.",
      "We should plan something soon. Let me know what works for you.",
      "Hope everything is going well. Would love to hear from you.",
      "Thinking of you. Let me know when you have a moment to chat.",
    ],
  },
  {
    name: "low-priority-work",
    count: 50,
    senders: [
      { name: "HR Team", email: "hr@acmecorp.com" },
      { name: "IT Support", email: "itsupport@acmecorp.com" },
      { name: "All Hands", email: "allhands@acmecorp.com" },
      { name: "Team Social", email: "social@acmecorp.com" },
      { name: "Facilities", email: "facilities@acmecorp.com" },
      { name: "Marketing", email: "marketing@acmecorp.com" },
      { name: "Admin", email: "admin@acmecorp.com" },
    ],
    subjectTemplates: [
      "All-hands meeting notes from last week",
      "Team lunch next Friday",
      "Office maintenance scheduled",
      "New employee onboarding",
      "Company newsletter - March edition",
      "IT maintenance window reminder",
      "Team building event survey",
      "Office policy updates",
    ],
    bodyTemplates: [
      "Here are the notes from our recent meeting. Let me know if you have any questions.",
      "Just a friendly reminder about the upcoming event. Hope to see you there.",
      "This is for your information. No action required at this time.",
      "Please review when you have a chance. We appreciate your feedback.",
      "FYI - this might be relevant to your work. Feel free to reach out if needed.",
    ],
  },
  {
    name: "newsletters",
    count: 50,
    senders: [
      { name: "Tech Digest", email: "newsletter@techdigest.io" },
      { name: "Industry Weekly", email: "news@industryweekly.com" },
      { name: "Dev Tools Update", email: "updates@devtools.net" },
      { name: "Startup News", email: "news@startupnews.com" },
      { name: "Code Review", email: "editor@codereview.org" },
      { name: "AI Insights", email: "newsletter@aiinsights.ai" },
    ],
    subjectTemplates: [
      "Weekly tech digest - latest updates",
      "Industry trends you should know",
      "New tools and frameworks this month",
      "Developer productivity tips",
      "Open source highlights",
      "Tech industry news roundup",
      "Best practices and patterns",
      "Community spotlight",
    ],
    bodyTemplates: [
      "Here is your weekly roundup of the latest news and updates from the tech world.",
      "We have curated the most important stories for you this week. Enjoy reading.",
      "Check out these new tools and resources that might interest you.",
      "This week we are highlighting some interesting developments in the industry.",
      "Thanks for subscribing. Here is what caught our attention recently.",
    ],
  },
  {
    name: "promotions-spam",
    count: 40,
    senders: [
      { name: "Deal Alert", email: "deals@shoppingdeals.com" },
      { name: "Flash Sale", email: "sales@flashsale.net" },
      { name: "Survey Team", email: "survey@feedback.com" },
      { name: "Free Trial", email: "trial@saasproduct.io" },
      { name: "Marketing Team", email: "marketing@promo.biz" },
      { name: "Special Offer", email: "offers@specialdeals.com" },
    ],
    subjectTemplates: [
      "Limited time offer - 50% off",
      "Your free trial expires soon",
      "Complete our quick survey",
      "Exclusive deal just for you",
      "Last chance to save",
      "Special promotion ending today",
      "Win a prize - enter now",
      "Don't miss this opportunity",
    ],
    bodyTemplates: [
      "Act now to take advantage of this special offer. Limited quantities available.",
      "Your free trial is about to expire. Upgrade now to continue using our service.",
      "We would love your feedback. This quick survey takes just two minutes.",
      "This exclusive deal is only available for a limited time. Don't miss out.",
      "Thank you for being a valued customer. Here is a special offer just for you.",
    ],
  },
];

function randomChoice<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateEmailBody(templates: string[]): string {
  const sentenceCount = randomInt(2, 6);
  const sentences: string[] = [];

  for (let i = 0; i < sentenceCount; i++) {
    sentences.push(randomChoice(templates));
  }

  return sentences.join(" ");
}

function formatDate(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const day = days[date.getUTCDay()];
  const month = months[date.getUTCMonth()];
  const dateNum = date.getUTCDate().toString();
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  const year = date.getUTCFullYear().toString();

  return `${day}, ${dateNum} ${month} ${year} ${hours}:${minutes}:${seconds} +0000`;
}

function generateRandomDateInLast30Days(): Date {
  const now = new Date();
  const daysAgo = randomInt(0, 29);
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  date.setUTCHours(randomInt(8, 18));
  date.setUTCMinutes(randomInt(0, 59));
  date.setUTCSeconds(randomInt(0, 59));
  return date;
}

function generateEmail(category: EmailCategory): string {
  const sender = randomChoice(category.senders);
  const subject = randomChoice(category.subjectTemplates);
  const body = generateEmailBody(category.bodyTemplates);
  const date = generateRandomDateInLast30Days();

  return `From: ${sender.name} <${sender.email}>
To: user@example.com
Subject: ${subject}
Date: ${formatDate(date)}

${body}
`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: npx ts-node generate-inbox.ts <output-dir> [count]");
    process.exit(1);
  }

  const outputDir = args[0];
  const count = args[1] ? parseInt(args[1], 10) : 200;

  if (isNaN(count) || count < 1) {
    console.error("Count must be a positive number");
    process.exit(1);
  }

  await mkdir(outputDir, { recursive: true });

  let emailIndex = 1;
  const categoryCounts: Record<string, number> = {};

  for (const category of categories) {
    categoryCounts[category.name] = 0;
  }

  for (const category of categories) {
    for (let i = 0; i < category.count && emailIndex <= count; i++) {
      const emailNumber = emailIndex.toString().padStart(3, "0");
      const filename = `email-${emailNumber}.eml`;
      const filepath = join(outputDir, filename);

      const emailContent = generateEmail(category);
      await writeFile(filepath, emailContent, "utf-8");

      categoryCounts[category.name]++;
      emailIndex++;
    }
  }

  if (emailIndex <= count) {
    const remaining = count - emailIndex + 1;
    const lastCategory = categories[categories.length - 1];

    for (let i = 0; i < remaining; i++) {
      const emailNumber = emailIndex.toString().padStart(3, "0");
      const filename = `email-${emailNumber}.eml`;
      const filepath = join(outputDir, filename);

      const emailContent = generateEmail(lastCategory, emailIndex);
      await writeFile(filepath, emailContent, "utf-8");

      categoryCounts[lastCategory.name]++;
      emailIndex++;
    }
  }

  console.log(`Generated ${(emailIndex - 1).toString()} emails in ${outputDir}`);
  console.log("Category distribution:");
  for (const category of categories) {
    console.log(`  ${category.name}: ${categoryCounts[category.name].toString()} emails`);
  }
}

main().catch((error: unknown) => {
  console.error("Error:", error);
  process.exit(1);
});
