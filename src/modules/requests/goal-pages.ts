/**
 * What each campaign tab says, so a tab is worth opening even before anyone has posted a campaign for it. Everything
 * here is guidance written for the page — never campaigns, creators or numbers presented as real. Edit freely: the
 * pages read it as is.
 */
import type { CampaignGoal } from './goals';

export type GoalPage = {
  headline: string;
  pitch: string;
  steps: [title: string, text: string][];
  delivers: string[];
  rule: string;
  briefTitle: string;
  briefText: string;
};

export const GOAL_PAGES: Record<CampaignGoal, GoalPage> = {
  LAUNCH: {
    headline: 'Launch day, told by people your market already follows.',
    pitch: 'Line up creators before, on and after your launch so the news lands as one coordinated wave instead of a single post.',
    steps: [
      ['Set the date and the story', 'Say what launches, when, and the one thing people should do.'],
      ['Pick creators by audience', 'Compare approaches and quotes. Each hire holds its share of your budget.'],
      ['Posts go out around the date', 'You approve each delivery, and creators are paid on approval.'],
    ],
    delivers: ['Announcement threads', 'Launch-day videos', 'Follow-up explainers', 'Recap posts'],
    rule: 'Every post is labelled as sponsored.',
    briefTitle: 'Mainnet launch threads for launch week',
    briefText: 'What launches and when, who it is for, the key message, and the one action readers should take.',
  },
  SHILL: {
    headline: 'Many voices, each one clearly sponsored.',
    pitch: 'Short posts, replies and quote posts from many creators at once, for a steady presence through a token week or a campaign push.',
    steps: [
      ['Set the rate and the volume', 'A price per post and how many creators you need.'],
      ['See every account before hiring', 'Creators apply with the account they will post from.'],
      ['Pay per approved post', 'Add a view bonus with a hard cap if you want reach to count.'],
    ],
    delivers: ['Short posts', 'Quote posts', 'Replies in threads', 'Community shout-outs'],
    rule: 'Each post carries a sponsorship label. No fake engagement, no promised returns.',
    briefTitle: 'Token week: disclosed posts from 30 creators on X',
    briefText: 'The project in two lines, what to mention, the link, the dates, and the sponsorship label to use.',
  },
  AIRDROP: {
    headline: 'Explain the airdrop to the people who actually qualify.',
    pitch: 'Creators walk real users through eligibility and how to take part, so claims come from informed people rather than farms.',
    steps: [
      ['Share the rules', 'Eligibility, snapshot, chain and dates, exactly as they are.'],
      ['Creators explain it their way', 'Threads, videos and step-by-step guides for their audience.'],
      ['Check before it goes out', 'Approve the delivery before anyone is paid.'],
    ],
    delivers: ['Eligibility explainers', 'How-to-claim guides', 'Snapshot reminders', 'FAQ threads'],
    rule: 'Posts never promise returns or guarantee rewards.',
    briefTitle: 'Explain our airdrop eligibility and claim steps',
    briefText: 'Who qualifies, the snapshot date, the chain, how to claim, and what posts must not say.',
  },
  AMA: {
    headline: 'Put your team in front of a live audience.',
    pitch: 'Hire a host or a guest for an AMA, X Space or community call. You fix the length when you hire and agree the time with the creator.',
    steps: [
      ['Say what the session is for', 'The topic, who speaks for your team, and the audience you want.'],
      ['Agree the time together', 'The day, hour and link are settled in the order messages.'],
      ['Pay once it has happened', 'Approve the session when it is done.'],
    ],
    delivers: ['Hosted X Spaces', 'Guest appearances', 'Community AMAs', 'Session recaps'],
    rule: 'The session length is fixed when you hire; the time is agreed in the order.',
    briefTitle: 'Host a 60-minute X Space with our founders',
    briefText: 'The topic, the speakers, the audience, questions to cover, and any times that will not work.',
  },
  TESTNET: {
    headline: 'Bring real testers, not just clicks.',
    pitch: 'Creators show their audience how to try your testnet step by step and what to report, so you get feedback you can use.',
    steps: [
      ['Share the testnet and the tasks', 'The network, the faucet, and what testers should try.'],
      ['Creators make the walkthroughs', 'Guides their audience can follow from wallet to first transaction.'],
      ['Approve and pay per delivery', 'Revisions happen before approval.'],
    ],
    delivers: ['Walkthrough threads', 'Screen-recorded guides', 'Bug-report templates', 'Task checklists'],
    rule: 'Testnet tokens have no value, and posts say so.',
    briefTitle: 'Testnet walkthrough: wallet to first swap',
    briefText: 'The testnet link and faucet, the tasks to try, what feedback you want, and where testers report it.',
  },
  EDUCATION: {
    headline: 'Explain what you built, in depth.',
    pitch: 'Tutorials, deep dives and explainers delivered to you, to publish on your own channels or in your docs.',
    steps: [
      ['Describe the topic and the reader', 'What they already know and what they should understand after.'],
      ['Compare approaches and samples', 'Pick the creator whose past work fits the depth you need.'],
      ['Revise, then approve', 'Included revisions happen before you approve and pay.'],
    ],
    delivers: ['Deep-dive articles', 'Tutorial threads', 'Explainer videos', 'Docs-ready guides'],
    rule: 'You receive the files and the usage rights agreed at hire.',
    briefTitle: 'A deep dive on how our bridge settles',
    briefText: 'The topic, the reader, the sources to use, the length and format, and where it will be published.',
  },
  MEMES: {
    headline: 'Visuals your community will actually share.',
    pitch: 'Memes, stickers, banners and art made for your project, with the license you need stated before anyone starts.',
    steps: [
      ['Describe the style and the uses', 'References, formats and where the files will appear.'],
      ['Choose the license', 'Non-exclusive or exclusive, in your own words.'],
      ['Receive the files', 'Delivered in the order and approved before payment.'],
    ],
    delivers: ['Meme sets', 'Sticker packs', 'Banners and headers', 'Illustrations'],
    rule: 'The rights you asked for are frozen when you hire.',
    briefTitle: 'A meme and sticker pack for our community',
    briefText: 'The mascot or brand assets, the tone, the formats and sizes, and how many pieces you need.',
  },
};
