// Who may use the scrims bot's admin features.
// Manage Server, OR any Discord user ID listed in the ALLOWED_USER_IDS
// environment variable (comma-separated, set in Railway -> Variables).
const { PermissionFlagsBits } = require('discord.js');

function envAllowedIds() {
  return [...new Set((process.env.ALLOWED_USER_IDS || '').match(/\d{15,25}/g) || [])];
}

function isAllowedUser(userId) {
  return envAllowedIds().includes(String(userId));
}

function canManageServer(member) {
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.ManageGuild) || isAllowedUser(member.id);
}

// Silent denial: people without permission get NO visible reply. Discord
// still needs every interaction acknowledged, so buttons/selects are deferred
// invisibly and slash commands/modals get an ephemeral defer that is deleted
// immediately.
async function silentDeny(interaction) {
  try {
    if (!interaction || interaction.replied || interaction.deferred) return null;
    if (typeof interaction.isAutocomplete === 'function' && interaction.isAutocomplete()) return null;
    if (typeof interaction.isMessageComponent === 'function' && interaction.isMessageComponent()) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ ephemeral: true });
      await interaction.deleteReply().catch(() => {});
    }
  } catch (_) { /* silent */ }
  return null;
}

module.exports = { silentDeny, envAllowedIds, isAllowedUser, canManageServer };
