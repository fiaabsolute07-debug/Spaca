-- Campaign goals: what a campaign is for (launch, airdrop, shiller, testnet, AMA & Spaces, education, memes & art), so
-- campaigns can be browsed the way web3 teams talk about them. The category still says what kind of work is done.
--
-- Campaigns posted before goals existed keep no goal: nobody said what they were for, and guessing would put words in
-- the buyer's mouth. They still show under "All campaigns".

ALTER TABLE app.requests ADD COLUMN campaign_goal text
  CHECK (campaign_goal IS NULL OR campaign_goal IN ('LAUNCH','AIRDROP','SHILL','TESTNET','AMA','EDUCATION','MEMES'));
CREATE INDEX requests_open_goal_idx ON app.requests (campaign_goal, application_deadline) WHERE status = 'OPEN';
