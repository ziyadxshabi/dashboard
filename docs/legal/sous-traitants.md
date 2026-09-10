# Sous-traitants techniques (instance type)

Le cabinet active seulement les services qu’il configure. Aucun de ces acteurs n’est « CNDP certified » du fait d’être listé ici.

| Service | Rôle | Données typiques | Région |
| --- | --- | --- | --- |
| Vercel | Hébergement UI + fonctions | Logs HTTP, cookies de session | Au choix du projet ; pas de région Maroc |
| PostgreSQL / Supabase | Base SSOT | Dossiers, RDV, consentements, audit | **Préférer UE (Francfort)** |
| Cal.com | Calendrier public | Nom, e-mail, téléphone, créneau | Extra-territorial |
| Twilio | SMS / voix | Numéro, corps du SMS | Extra-territorial (souvent US) |
| Resend | E-mail (optionnel) | E-mail, contenu du message | Extra-territorial |
| Upstash Redis | Limitation des logins (optionnel) | IP / compteur, **pas** le dossier patient | Extra-territorial |

n8n, Baserow et Google Sheets **ne font pas** partie du runtime.

Le contrat cabinet ↔ éditeur : [clauses-sous-traitant.md](clauses-sous-traitant.md).
Le déploiement : [../deploy-your-clinic.md](../deploy-your-clinic.md).
