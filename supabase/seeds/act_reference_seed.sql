-- Phase 0 seed — act_reference : nomenclature dentaire marocaine (NGAP)
-- Source coefficients : Nomenclature Générale des Actes Professionnels, Royaume du Maroc
--   (chapitre VI art.5 ODF, chapitre VII Dents/gencives, section III Prothèse) — smorl.ma/pdfs/Nomenclatures.pdf
-- Source lettres clés : ANAM — anam.ma/anam/regulation/tarification-nationale-de-reference/
--   D soins dentaires = 17.50 MAD | D prothèses = 12.50 MAD | forfait ODF = 1500 MAD/semestre
-- TNR = coefficient x lettre clé. Vérifié : D700=175.00, D706=437.50, D754=2250.00, D773=1500.00
-- Rappels CNSS : remboursement 70% TNR (80% CNOPS) ; prothèses plafonnées à 70% de 3000 MAD
--   = 2100 MAD / bénéficiaire / 2 ans ; dossier < 60 jours ; ODF = accord préalable (<16 ans).
-- Non remboursé CNSS : esthétique (blanchiment), implantologie, prothèses provisoires,
--   reprises de traitement, renouvellements de prothèses, actes hors nomenclature.
-- TODO(verify) : 2e coefficient de certains actes chirurgicaux (voir notes) ;
--   prise en charge des actes parodontaux D709-D711 ; taux dentaire 70% vs 80% (réforme 2020).
-- NOTE SCHEMA : ce seed suppose deux colonnes en plus du spec Phase 0 initial :
--   coefficient NUMERIC NULL, letter_key TEXT NOT NULL DEFAULT 'soins'
--   (permet de recalculer le TNR si l'ANAM revalorise la lettre clé D).


INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D621', 'Luxation ATM récente — traitement orthopédique', 'chirurgie', 5, 'soins', 87.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D622', 'Lésions ATM — traitement opératoire', 'chirurgie', 40, 'soins', 700.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 30 (à vérifier)
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D623', 'Méniscectomie unilatérale, résection du condyle', 'chirurgie', 80, 'soins', 1400.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 30
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D624', 'Réduction sanglante luxation temporo-maxillaire', 'chirurgie', 80, 'soins', 1400.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 30
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D625', 'Arthroplastie constriction permanente (endo-prothèse non comprise)', 'chirurgie', 100, 'soins', 1750.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 50
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D626', 'Examen ODF avec empreinte diagnostic (radios remboursées en sus)', 'orthodontie', 15, 'soins', 262.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- accord préalable
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D627', 'Analyse céphalométrique (en supplément)', 'orthodontie', 5, 'soins', 87.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D628', 'Rééducation déglutition/parole — par série de 12 séances, la séance', 'orthodontie', 5, 'soins', 87.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D629', 'Traitement des dysmorphoses — par période de 6 mois', 'orthodontie', 90, 'soins', 1575.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- forfait ODF plafonné à 1500 MAD/semestre (ANAM)
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D630', 'Traitement dysmorphoses — plafond global', 'orthodontie', 540, 'soins', 9450.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- plafond
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D631', 'Séance de surveillance (interruption provisoire)', 'orthodontie', 5, 'soins', 87.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D632', 'Contention/rééducation — première année', 'orthodontie', 75, 'soins', 1312.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D633', 'Contention/rééducation — deuxième année', 'orthodontie', 50, 'soins', 875.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D634', 'Mise en place arcade — canine incluse (<18 ans)', 'orthodontie', 150, 'soins', 2625.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D635', 'Mise en place arcade — deux canines incluses (<18 ans)', 'orthodontie', 200, 'soins', 3500.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D636', 'Contention post-orthodontique — première année', 'orthodontie', 75, 'soins', 1312.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- avis technique favorable requis
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D637', 'Contention post-orthodontique — deuxième année', 'orthodontie', 50, 'soins', 875.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D638', 'Disjonction intermaxillaire rapide (insuffisance respiratoire)', 'orthodontie', 180, 'soins', 3150.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D639', 'Orthopédie bec-de-lièvre/division palatine — forfait annuel', 'orthodontie', 200, 'soins', 3500.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D640', 'Orthopédie bec-de-lièvre — période d''attente', 'orthodontie', 60, 'soins', 1050.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D641', 'ODF pré-chirurgicale >16 ans — 6 mois non renouvelable', 'orthodontie', 90, 'soins', 1575.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D700', 'Obturation — cavité simple, traitement global', 'soins', 10, 'soins', 175.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D701', 'Obturation — cavité composée 2 faces, traitement global', 'soins', 10, 'soins', 175.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D702', 'Obturation — cavité composée 3 faces et plus', 'soins', 15, 'soins', 262.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D703', 'Pulpotomie / pulpectomie coronaire + obturation chambre pulpaire', 'soins', 7, 'soins', 122.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D704', 'Dévitalisation — groupe inciso-canin', 'soins', 10, 'soins', 175.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- radio pré+post-op obligatoires; +50% si enfant <13 ans (dent permanente)
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D705', 'Dévitalisation — groupe prémolaires', 'soins', 15, 'soins', 262.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- radio pré+post-op obligatoires; +50% si enfant <13 ans
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D706', 'Dévitalisation — groupe molaires', 'soins', 25, 'soins', 437.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- radio pré+post-op obligatoires; +50% si enfant <13 ans
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D707', 'Restauration 2 faces+ avec ancrage radiculaire (phase plastique)', 'soins', 33, 'soins', 577.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D708', 'Détartrage complet sus et sous-gingival — par séance (max 2)', 'parodontologie', 12, 'soins', 210.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D709', 'Ligature métallique (parodontopathies)', 'parodontologie', 8, 'soins', 140.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- vérifier prise en charge CNSS (paro souvent exclue)
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D710', 'Attelle métallique (parodontopathies)', 'parodontologie', 40, 'soins', 700.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- vérifier prise en charge CNSS
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D711', 'Prothèse attelle de contention', 'parodontologie', 70, 'soins', 1225.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- vérifier prise en charge CNSS
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D712', 'Scellement prophylactique puits/sillons — par dent', 'parodontologie', 8, 'soins', 140.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- limité 1re/2e molaires permanentes, 1x/dent, <14 ans
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D713', 'Extraction — dent permanente', 'chirurgie', 10, 'soins', 175.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D714', 'Extraction — chaque dent suivante, même séance', 'chirurgie', 5, 'soins', 87.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D715', 'Extraction — dent lactéale', 'chirurgie', 8, 'soins', 140.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D716', 'Extraction — dent lactéale suivante, même séance', 'chirurgie', 4, 'soins', 70.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D717', 'Extraction par alvéolectomie', 'chirurgie', 10, 'soins', 175.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D718', 'Anesthésie générale — 1 à 12 extractions', 'chirurgie', 25, 'soins', 437.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D719', 'Anesthésie générale — 13 extractions et +', 'chirurgie', 30, 'soins', 525.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D720', 'Extraction dent de sagesse incluse/enclavée/germe — la première', 'chirurgie', 40, 'soins', 700.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- radio pré-op obligatoire
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D721', 'Extraction dent de sagesse incluse — chacune des suivantes', 'chirurgie', 20, 'soins', 350.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D722', 'AG pour dents de sagesse — une dent', 'chirurgie', 25, 'soins', 437.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D723', 'AG pour dents de sagesse — deux dents ou plus', 'chirurgie', 40, 'soins', 700.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D724', 'Germectomie (autre que dent de sagesse)', 'chirurgie', 20, 'soins', 350.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D725', 'Extraction dent incluse ou enclavée', 'chirurgie', 40, 'soins', 700.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D726', 'Extraction canine incluse', 'chirurgie', 50, 'soins', 875.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 30
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D727', 'Extraction odontoïde / dent surnuméraire incluse', 'chirurgie', 40, 'soins', 700.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D728', 'Extraction dent en désinclusion, couronne sous-muqueuse', 'chirurgie', 20, 'soins', 350.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D729', 'Extraction dent en désinclusion, position palatine/linguale', 'chirurgie', 50, 'soins', 875.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 30
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D730', 'Extraction dent ectopique incluse', 'chirurgie', 80, 'soins', 1400.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 30
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D731', 'Extraction chirurgicale + réimplantation — une dent', 'chirurgie', 100, 'soins', 1750.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 30
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D732', 'Extraction chirurgicale + réimplantation — deux dents', 'chirurgie', 150, 'soins', 2625.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 40
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D733', 'Trépanation sinus maxillaire (recherche racine)', 'chirurgie', 40, 'soins', 700.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D734', 'Dégagement chirurgical couronne dent incluse', 'chirurgie', 30, 'soins', 525.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D735', 'Régularisation crête alvéolaire — localisée', 'chirurgie', 5, 'soins', 87.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D736', 'Régularisation crête — hémimaxillaire ou canine à canine', 'chirurgie', 15, 'soins', 262.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D737', 'Régularisation crête — totalité', 'chirurgie', 30, 'soins', 525.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D738', 'Curetage périapical ± résection apicale', 'chirurgie', 15, 'soins', 262.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- radio obligatoire
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D739', 'Kyste petit volume — voie alvéolaire élargie', 'chirurgie', 15, 'soins', 262.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- radio obligatoire
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D740', 'Kyste étendu (2 dents, trépanation osseuse)', 'chirurgie', 30, 'soins', 525.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D741', 'Kyste étendu à un segment important du maxillaire', 'chirurgie', 50, 'soins', 875.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 30
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D742', 'Gingivectomie partielle', 'chirurgie', 5, 'soins', 87.50, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D743', 'Gingivectomie étendue à un sextant', 'chirurgie', 20, 'soins', 350.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D744', 'Traitement hémorragie post-opératoire (autre séance)', 'chirurgie', 10, 'soins', 175.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D745', 'Désinsertion musculaire — vestibule sup. ou inf.', 'chirurgie', 40, 'soins', 700.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 20
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D746', 'Désinsertion plancher de la bouche', 'chirurgie', 60, 'soins', 1050.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 20
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D747', 'Approfondissement vestibule par greffe cutanée', 'chirurgie', 40, 'soins', 700.00, FALSE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- 2e coeff 20

INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D748', 'Couronne ajustée — acier ou nickel-chromé', 'prothese', 40, 'prothese', 500.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D749', 'Couronne ajustée — or jaune / métaux précieux', 'prothese', 60, 'prothese', 750.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D750', 'Couronne coulée — acier ou nickel-chromé', 'prothese', 50, 'prothese', 625.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D751', 'Couronne coulée — or jaune / métaux précieux', 'prothese', 80, 'prothese', 1000.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D752', 'Couronne à incrustation vestibulaire / veneer — acier', 'prothese', 75, 'prothese', 937.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D753', 'Couronne à incrustation vestibulaire — or / métaux précieux', 'prothese', 120, 'prothese', 1500.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D754', 'Couronne céramo-métallique', 'prothese', 180, 'prothese', 2250.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- le plus courant en cabinet
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D755', 'Couronne jacket céramo-métal', 'prothese', 180, 'prothese', 2250.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D756', 'Couronne jacket cuite', 'prothese', 40, 'prothese', 500.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D757', 'Bridge — chaque élément compté comme couronne unitaire', 'prothese', NULL, 'prothese', NULL, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;  -- cotation = couronne de même nature
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D758', 'Inlay-core — dent uniradiculaire', 'prothese', 80, 'prothese', 1000.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D759', 'Inlay-core — dent pluriradiculaire', 'prothese', 100, 'prothese', 1250.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D760', 'Dent à pivot esthétique — or / métaux précieux', 'prothese', 150, 'prothese', 1875.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D761', 'Prothèse adjointe plaque plastique — 1 à 3 dents', 'prothese', 40, 'prothese', 500.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D762', 'Prothèse adjointe — 4 dents', 'prothese', 45, 'prothese', 562.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D763', 'Prothèse adjointe — 5 dents', 'prothese', 50, 'prothese', 625.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D764', 'Prothèse adjointe — 6 dents', 'prothese', 55, 'prothese', 687.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D765', 'Prothèse adjointe — 7 dents', 'prothese', 60, 'prothese', 750.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D766', 'Prothèse adjointe — 8 dents', 'prothese', 65, 'prothese', 812.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D767', 'Prothèse adjointe — 9 dents', 'prothese', 70, 'prothese', 875.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D768', 'Prothèse adjointe — 10 dents', 'prothese', 75, 'prothese', 937.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D769', 'Prothèse adjointe — 11 dents', 'prothese', 80, 'prothese', 1000.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D770', 'Prothèse adjointe — 12 dents', 'prothese', 85, 'prothese', 1062.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D771', 'Prothèse adjointe — 13 dents', 'prothese', 90, 'prothese', 1125.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D772', 'Prothèse adjointe — 14 dents', 'prothese', 95, 'prothese', 1187.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D773', 'Prothèse adjointe totale — maxillaire supérieur', 'prothese', 120, 'prothese', 1500.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D774', 'Prothèse adjointe totale — maxillaire inférieur', 'prothese', 120, 'prothese', 1500.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D775', 'Supplément — plaque base métallique', 'prothese', 120, 'prothese', 1500.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D776', 'Supplément — dent contreplaquée sur plaque plastique', 'prothese', 10, 'prothese', 125.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D777', 'Supplément — dent contreplaquée/massive sur plaque métallique', 'prothese', 15, 'prothese', 187.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D778', 'Réparation — fracture plaque plastique', 'prothese', 10, 'prothese', 125.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D779', 'Réparation — fracture plaque métallique', 'prothese', 15, 'prothese', 187.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D780', 'Dent/crochet ajouté sur appareil — premier élément', 'prothese', 10, 'prothese', 125.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D781', 'Dent/crochet ajouté — éléments suivants', 'prothese', 5, 'prothese', 62.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D782', 'Dent contreplaquée/crochet soudé sur appareil métallique — par élément', 'prothese', 20, 'prothese', 250.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D783', 'Dent/crochet remonté après réparation plaque métallique — par élément', 'prothese', 3, 'prothese', 37.50, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D784', 'Remplacement de facette', 'prothese', 8, 'prothese', 100.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO act_reference (code, label, category, coefficient, letter_key, tnr_mad, requires_prior_approval, active) VALUES
  ('D785', 'Prothèse partielle avec attachement — supplément', 'prothese', 40, 'prothese', 500.00, TRUE, TRUE)
  ON CONFLICT (code) DO NOTHING;
