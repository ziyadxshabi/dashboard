# Clauses sous-traitant (modèle)

**Ceci n’est pas un avis juridique.** Faites relire ces clauses par un conseil marocain avant de les signer. Elles n’équivalent pas à une autorisation CNDP.

Contexte produit : licence logicielle **paiement unique** (ex. 10 000 MAD). Le cabinet paie l’hébergement. Pas de paiement carte dans l’application.

## Parties

- **Responsable de traitement :** le cabinet dentaire qui exploite l’instance (dossiers patients, SMS, rendez-vous).
- **Sous-traitant :** l’éditeur / intégrateur de DentaFlow OS (fourniture du logiciel, assistance technique éventuelle).

## Objet

Le sous-traitant met à disposition le logiciel DentaFlow OS. Le traitement des données de santé et de contact s’effectue sur l’infrastructure **choisie et payée par le cabinet** (Vercel, PostgreSQL, Twilio, Cal.com, etc.).

## Instructions

Le sous-traitant n’agit que sur instruction du cabinet. Il ne revend pas les dossiers patients. Il n’ajoute pas de champs d’identité inutiles (adresse, CIN).

## Sécurité

- authentification staff (scrypt + cookie httpOnly) ;
- isolation par `clinic_id` (UUID JWT) ;
- pas de secrets dans le navigateur ;
- journal `audit_events` pour export / effacement / modification de dossier.

## Sous-traitants ultérieurs

Voir [sous-traitants.md](sous-traitants.md). Le cabinet autorise ces sous-traitants techniques lorsqu’il active les intégrations correspondantes.

## Transferts

Les hébergeurs n’offrent en général pas de région Maroc. Un transfert hors Maroc (UE / États-Unis selon le service) est à traiter dans le dossier CNDP du cabinet. Voir [cndp-checklist.md](cndp-checklist.md).

## Fin de contrat

À la fin de l’accompagnement, le cabinet conserve sa base. Le sous-traitant n’emporte pas une copie des dossiers. Export et anonymisation sont disponibles dans le logiciel (`patient-export` / `patient-erase`).

## Facturation

La licence est facturée **hors application** (facture DGI). Pas de CMI, Stripe ni abonnement dans DentaFlow.
