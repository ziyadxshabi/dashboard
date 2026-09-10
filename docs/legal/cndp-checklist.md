# Checklist dossier CNDP (cabinet dentaire)

**Ceci n’est pas un dépôt CNDP.** Un conseil / DPO du cabinet constitue le dossier. Un pull request ne « certifie » pas l’instance.

Loi 09-08 relative à la protection des personnes physiques à l’égard du traitement des données à caractère personnel. Les données de santé relèvent en pratique d’une **autorisation**, pas d’une simple mention sur un site.

## Identité du responsable

- [ ] Raison sociale et ICE du cabinet
- [ ] Adresse du cabinet (celle du responsable, pas un champ patient dans DentaFlow)
- [ ] Personne à contacter / DPO le cas échéant

## Traitements à décrire

- [ ] Dossier patient (nom, téléphone, e-mail optionnel, notes cliniques)
- [ ] Agenda / rendez-vous
- [ ] Liste d’attente
- [ ] SMS de confirmation et rappels (opt-in)
- [ ] Comptes staff

DentaFlow **ne stocke pas** l’adresse du patient ni le CIN. Ne les ajoutez pas « pour être complet ».

## Bases et finalités

- [ ] Exécution des soins et du rendez-vous
- [ ] Consentement distinct pour les SMS (case Loi 09-08) ; une case vide = pas d’envoi
- [ ] Durées de conservation (suivi des soins, puis export / anonymisation)

## Transferts et sous-traitants

- [ ] Liste [sous-traitants.md](sous-traitants.md)
- [ ] Région PostgreSQL (préférer l’UE, ex. Francfort)
- [ ] Mention Cal.com et Twilio comme destinataires du nom / téléphone
- [ ] Demande d’autorisation de transfert hors Maroc si le CNDP l’exige

## Mesures

- [ ] Mots de passe seed changés
- [ ] `JWT_SECRET` unique
- [ ] Pages `/privacy.html` et `/terms.html` liées depuis la connexion
- [ ] Notice sur `/book/<slug>`
- [ ] Procédure d’export / effacement connue de l’assistante

## Ce que ce logiciel ne fait pas

- Il ne dépose pas le dossier à la CNDP.
- Il n’affiche pas un badge « certifié CNDP ».
- Il n’émet pas la facture 10 000 MAD (DGI, hors app).
