/**
 * What a campaign is for, as web3 teams name it. The category (CREATE, PUBLISH, ACCESS, DIGITAL) says what kind of work
 * a creator does; the goal says why the buyer wants it, and is how campaigns are browsed. A goal suggests the category
 * that usually fits, and the buyer can still pick another.
 *
 * Pure data, shared by the server and the browser.
 */
export type CampaignGoal = 'LAUNCH' | 'AIRDROP' | 'SHILL' | 'TESTNET' | 'AMA' | 'EDUCATION' | 'MEMES';

export type CampaignGoalInfo = {
  value: CampaignGoal;
  /** The URL form: /requests?goal=<slug>. */
  slug: string;
  title: string;
  /** One line for menus. */
  short: string;
  /** What a buyer is asking for, for the brief form and the page heading. */
  need: string;
  taxonomy: 'CREATE' | 'PUBLISH' | 'ACCESS' | 'DIGITAL';
};

// Tab order on the campaigns pages, the header menu and the brief form.
export const CAMPAIGN_GOALS: readonly CampaignGoalInfo[] = [
  { value: 'LAUNCH', slug: 'launch', title: 'Launch', short: 'Launch-day threads, videos and posts', need: 'Announce a token, product or mainnet with threads, videos and launch-day posts.', taxonomy: 'PUBLISH' },
  { value: 'SHILL', slug: 'shiller', title: 'Shiller', short: 'Disclosed posts from many creators', need: 'Short posts, replies and quote posts from many creators, each one labelled as sponsored.', taxonomy: 'PUBLISH' },
  { value: 'AIRDROP', slug: 'airdrop', title: 'Airdrop', short: 'Explain who qualifies and how to join', need: 'Explain how to take part and who is eligible. Posts never promise returns.', taxonomy: 'PUBLISH' },
  { value: 'AMA', slug: 'ama', title: 'AMA & Spaces', short: 'Live AMAs, X Spaces and community calls', need: 'Host or join a live AMA, X Space or community call with your team.', taxonomy: 'ACCESS' },
  { value: 'TESTNET', slug: 'testnet', title: 'Testnet', short: 'Walkthroughs that bring real testers', need: 'Walkthroughs that show real users how to try your testnet and what to report.', taxonomy: 'CREATE' },
  { value: 'EDUCATION', slug: 'education', title: 'Education', short: 'Tutorials, deep dives and explainers', need: 'Tutorials, deep dives and explainers delivered to you for your own channels.', taxonomy: 'CREATE' },
  { value: 'MEMES', slug: 'memes', title: 'Memes & art', short: 'Memes, stickers and visuals you license', need: 'Memes, stickers, banners and visuals for your community, with the rights you need.', taxonomy: 'DIGITAL' },
];

export const CAMPAIGN_GOAL_VALUES: readonly CampaignGoal[] = CAMPAIGN_GOALS.map((goal) => goal.value);

export const goalByValue = (value: unknown): CampaignGoalInfo | null => CAMPAIGN_GOALS.find((goal) => goal.value === value) ?? null;

/** Accepts the URL slug or the stored value, in any case. */
export const goalBySlug = (value: unknown): CampaignGoalInfo | null => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text ? CAMPAIGN_GOALS.find((goal) => goal.slug === text || goal.value.toLowerCase() === text) ?? null : null;
};
