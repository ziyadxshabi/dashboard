'use strict';

function confirmSms(name) {
  return `Bonjour ${name} ! 🦷\n\nVotre consultation à la Clinique Dentaire Témara Mall est bien confirmée. À très bientôt !`;
}

function rescheduleSms(name) {
  return `Bonjour ${name}, la modification de votre RDV a bien été prise en compte.`;
}

function waitlistSms(name, url) {
  return `Bonjour ${name}, un créneau vient de se libérer aujourd'hui à la Clinique Dentaire Témara Mall. Cliquez rapidement ici pour réserver l'emplacement : ${url}`;
}

function slotFilledCleanupSms(url) {
  return `Le créneau d'urgence du jour a été comblé, mais vous pouvez planifier une autre date directement via notre portail patient : ${url}`;
}

function reminderSms(name, url) {
  return `Bonjour ${name}, nous vous rappelons votre consultation demain à la Clinique Dentaire Témara Mall. Répondez 1, oui ou ok pour confirmer. Pour gérer, modifier ou reporter votre visite : ${url}`;
}

function forceTomorrowSms(name) {
  return `Bonjour ${name}, rappel de votre rendez-vous demain à la Clinique Dentaire Témara Mall. Merci de confirmer votre présence (répondez 1, oui ou ok).`;
}

function bulkDefaultSms(name) {
  return `Bonjour ${name}, ceci est un message du cabinet dentaire. Veuillez nous contacter si besoin.`;
}

function leakSms(day, name, url) {
  if (Number(day) === 3) {
    return `Bonjour ${name}, nous avons remarqué que votre rendez-vous a été annulé ou manqué. Nous serions ravis de vous revoir — reprenez un créneau ici : ${url}`;
  }
  if (Number(day) === 7) {
    return `Bonjour ${name}, rappel amical : votre place au cabinet est toujours disponible. Reprenez rendez-vous en un clic : ${url}`;
  }
  return `Bonjour ${name}, dernière relance : nous aimerions vous revoir au cabinet. Réservez votre créneau dès maintenant : ${url}`;
}

function voicePortalSms(url) {
  return `Bonjour ! 🦷\n\nVoici votre portail patient sécurisé pour réserver ou gérer votre consultation à la clinique :\n${url}\n\nRépondez STOP pour ne plus recevoir de SMS.`;
}

function recallSms(name, url) {
  return `Bonjour ${name}, il est temps de planifier votre contrôle à 6 mois à la Clinique Dentaire Témara Mall. Réservez ici : ${url}`;
}

function referralSms({ name, lastVisit, allergies, note }) {
  const lines = [
    `Orientation — ${name || 'Patient'}`,
    lastVisit ? `Dernière visite : ${lastVisit}` : null,
    allergies ? `Allergies : ${allergies}` : 'Allergies : non renseignées',
    note ? String(note) : null,
  ].filter(Boolean);
  return lines.join('\n');
}

function leakEmailSubject(day) {
  if (Number(day) === 3) return 'Nous vous avons manqué — J+3';
  if (Number(day) === 7) return 'Rappel J+7 — Reprenez votre rendez-vous';
  return 'Dernière relance J+14 — Reprenez rendez-vous';
}

function reminderEmailSubject() {
  return 'Rappel : votre consultation demain — Clinique Dentaire Témara Mall';
}

function confirmEmailSubject(name) {
  return `🚨 Nouveau rendez-vous : ${name}`;
}

function cancelEmailSubject(name) {
  return `❌ Rendez-vous Annulé : ${name}`;
}

function rescheduleEmailSubject(name) {
  return `🔄 Rendez-vous Reporté : ${name}`;
}

const SLACK = {
  created: (name) => `✅ Nouveau RDV: ${name}`,
  cancelled: (name) =>
    `🚨 *Rendez-vous Annulé* 🚨 Le patient ${name} vient d'annuler son rendez-vous. Un créneau s'est libéré dans l'agenda. Veuillez vérifier Cal.com pour les disponibilités mises à jour.`,
  rescheduled: (name, startTime) =>
    `🔄 *Rendez-vous Modifié* 🔄\nLe patient ${name} a modifié son rendez-vous.\nNouvelle date et heure : ${startTime}\nL'agenda a été mis à jour automatiquement.`,
  smsFailed: (name) =>
    `⚠️ *[ATTENTION: ÉCHEC ENVOI SMS]* ⚠️\n_Le rendez-vous a été enregistré, mais le SMS de confirmation n'a pas pu être délivré au patient. Veuillez le contacter manuellement._\n\nPatient: ${name}`,
  badPhone: (phone) => `⚠️ SMS ignoré — téléphone invalide: ${phone || '(vide)'}`,
};

module.exports = {
  confirmSms,
  rescheduleSms,
  waitlistSms,
  slotFilledCleanupSms,
  reminderSms,
  forceTomorrowSms,
  bulkDefaultSms,
  leakSms,
  voicePortalSms,
  recallSms,
  referralSms,
  leakEmailSubject,
  reminderEmailSubject,
  confirmEmailSubject,
  cancelEmailSubject,
  rescheduleEmailSubject,
  SLACK,
};
