-- deliverable / deliverable_baton — anon read policies (cfaaa070 reopen fix).
--
-- The Navigator Deliverables view reads deliverable_board with the anon key. deliverable_board is a
-- security_invoker view, so anon's RLS on the underlying tables applies. deliverable + deliverable_baton
-- had RLS ENABLED but NO anon read policy → deny-all → the view returned [] to the browser while
-- service-role saw all rows (the "17 live rows but empty-state" symptom).
--
-- Mirror the existing relay_baton_public_read policy (board data is already anon-readable via relay_baton;
-- these two tables are board-display metadata at the same, lower-sensitivity tier). Additive, SELECT-only.
-- Keeper note (Connie): your tables; if you'd rather expose the board ONLY through a security_definer
-- deliverable_board view instead of opening the raw tables, that's a clean one-line alternative — swap and
-- drop these. Flagged on the board.
CREATE POLICY deliverable_public_read ON public.deliverable
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY deliverable_baton_public_read ON public.deliverable_baton
  FOR SELECT TO anon, authenticated USING (true);
