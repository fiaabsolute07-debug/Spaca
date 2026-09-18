-- Posting asks for less (2026-09-18). A service, a campaign brief and an auction listing each kept a list of fields
-- that had to be filled and a shortest length for most of them, and the database enforced both. The rule now is that
-- only what the marketplace cannot work without is required -- a title, a price, a closing time -- and no text has a
-- minimum at all: "1 WL spot" is a complete answer. Maximums stay, raised where the old ones cut real answers short.
--
-- Nothing here loosens a rule that protects money or identity: amounts, dates, collateral, idempotency keys, OAuth
-- verifiers and audit reasons are untouched.

-- Auction listings: title and price carry the listing; every other line is optional.
ALTER TABLE app.item_listings DROP CONSTRAINT item_listings_item_type_check;
ALTER TABLE app.item_listings ADD CONSTRAINT item_listings_item_type_check CHECK (char_length(item_type) <= 60);
ALTER TABLE app.item_listings DROP CONSTRAINT item_listings_title_check;
ALTER TABLE app.item_listings ADD CONSTRAINT item_listings_title_check CHECK (char_length(title) BETWEEN 1 AND 200);
ALTER TABLE app.item_listings DROP CONSTRAINT item_listings_project_name_check;
ALTER TABLE app.item_listings ADD CONSTRAINT item_listings_project_name_check CHECK (char_length(project_name) <= 120);
ALTER TABLE app.item_listings DROP CONSTRAINT item_listings_network_check;
ALTER TABLE app.item_listings ADD CONSTRAINT item_listings_network_check CHECK (char_length(network) <= 60);
ALTER TABLE app.item_listings DROP CONSTRAINT item_listings_quantity_check;
ALTER TABLE app.item_listings ADD CONSTRAINT item_listings_quantity_check CHECK (char_length(quantity) <= 120);
ALTER TABLE app.item_listings DROP CONSTRAINT item_listings_description_check;
ALTER TABLE app.item_listings ADD CONSTRAINT item_listings_description_check CHECK (char_length(description) <= 20000);
ALTER TABLE app.item_listings DROP CONSTRAINT item_listings_delivery_method_check;
ALTER TABLE app.item_listings ADD CONSTRAINT item_listings_delivery_method_check CHECK (char_length(delivery_method) <= 5000);
ALTER TABLE app.item_listings DROP CONSTRAINT item_listings_buyer_provides_check;
ALTER TABLE app.item_listings ADD CONSTRAINT item_listings_buyer_provides_check CHECK (char_length(buyer_provides) <= 500);

-- What a buyer hands over and what a seller shows as proof: still required, no longer measured.
ALTER TABLE app.item_sales DROP CONSTRAINT item_sales_buyer_details_check;
ALTER TABLE app.item_sales ADD CONSTRAINT item_sales_buyer_details_check CHECK (buyer_details IS NULL OR char_length(buyer_details) <= 500);
ALTER TABLE app.item_sales DROP CONSTRAINT item_sales_delivery_proof_check;
ALTER TABLE app.item_sales ADD CONSTRAINT item_sales_delivery_proof_check CHECK (delivery_proof IS NULL OR char_length(delivery_proof) <= 2000);

-- Services and the versions they publish.
ALTER TABLE app.services DROP CONSTRAINT services_title_check;
ALTER TABLE app.services ADD CONSTRAINT services_title_check CHECK (char_length(title) BETWEEN 1 AND 160);
ALTER TABLE app.services DROP CONSTRAINT services_description_check;
ALTER TABLE app.services ADD CONSTRAINT services_description_check CHECK (char_length(description) <= 10000);
ALTER TABLE app.services DROP CONSTRAINT services_digital_rights_text_check;
ALTER TABLE app.services ADD CONSTRAINT services_digital_rights_text_check CHECK (digital_rights_text IS NULL OR char_length(digital_rights_text) <= 4000);
ALTER TABLE app.service_versions DROP CONSTRAINT service_versions_title_check;
ALTER TABLE app.service_versions ADD CONSTRAINT service_versions_title_check CHECK (char_length(title) BETWEEN 1 AND 160);
ALTER TABLE app.service_versions DROP CONSTRAINT service_versions_description_check;
ALTER TABLE app.service_versions ADD CONSTRAINT service_versions_description_check CHECK (char_length(description) <= 10000);

-- Campaign briefs, the brief a buyer writes when hiring, and a creator's application note.
ALTER TABLE app.requests DROP CONSTRAINT requests_title_check;
ALTER TABLE app.requests ADD CONSTRAINT requests_title_check CHECK (char_length(title) BETWEEN 1 AND 160);
ALTER TABLE app.requests DROP CONSTRAINT requests_brief_check;
ALTER TABLE app.requests ADD CONSTRAINT requests_brief_check CHECK (char_length(brief) <= 12000);
ALTER TABLE app.orders DROP CONSTRAINT orders_brief_check;
ALTER TABLE app.applications DROP CONSTRAINT applications_note_check;
ALTER TABLE app.applications ADD CONSTRAINT applications_note_check CHECK (char_length(note) <= 8000);
