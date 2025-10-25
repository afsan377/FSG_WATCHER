// index.js — FSG WATCHER full (slash + prefix + MongoDB)
// Requirements: discord.js v14, mongoose, express, ms, dotenv
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField, REST, Routes, SlashCommandBuilder } = require('discord.js');
require('dotenv').config();
const ms = require('ms');
const express = require('express');
const mongoose = require('mongoose');

// ---------- CONFIG (use env vars) ----------
const OWNER_ROLE_ID = process.env.OWNER_ROLE_ID || ''; // optional
const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || '';
const MOD_ROLE_ID = process.env.MOD_ROLE_ID || '';
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID || '';
const MUTE_ROLE_ID = process.env.MUTE_ROLE_ID || ''; // role ID for mute (bot must have perms)
const BANLOG_CHANNEL = process.env.BANLOG_CHANNEL || '';
const MESSAGELOG_CHANNEL = process.env.MESSAGELOG_CHANNEL || '';
const GIVEAWAY_CHANNELS = (process.env.GIVEAWAY_CHANNELS || '').split(',').map(s=>s.trim()).filter(Boolean);
const PREFIX = process.env.PREFIX || '!';

// ---------- MONGODB (optional) ----------
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(()=>console.log('✅ Connected to MongoDB'))
    .catch(e=>console.error('MongoDB connect error:', e));
} else {
  console.log('ℹ️ No MONGODB_URI set — persistence will use local JSON files.');
}

// ---------- Schema (if using mongoose) ----------
let GiveawayModel=null, WarningModel=null;
if (process.env.MONGODB_URI) {
  const gSchema = new mongoose.Schema({
    messageId: String,
    channelId: String,
    prize: String,
    winners: Number,
    endsAt: Date,
    hostId: String
  });
  GiveawayModel = mongoose.models.Giveaway || mongoose.model('Giveaway', gSchema);

  const wSchema = new mongoose.Schema({
    guildId: String,
    userId: String,
    byId: String,
    reason: String,
    at: Date
  });
  WarningModel = mongoose.models.Warning || mongoose.model('Warning', wSchema);
}

// ---------- Local JSON fallback ----------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
function readJSON(name){ const p=path.join(DATA_DIR, name+'.json'); try{return JSON.parse(fs.readFileSync(p,'utf8')||'{}')}catch(e){return {}}}
function writeJSON(name,obj){ fs.writeFileSync(path.join(DATA_DIR,name+'.json'), JSON.stringify(obj,null,2)); }
['warnings','giveaways'].forEach(f => { const p = path.join(DATA_DIR, f + '.json'); if (!fs.existsSync(p)) fs.writeFileSync(p, '{}'); });

// ---------- Express keep-alive ----------
const app = express();
app.get('/', (req,res)=>res.send('FSG WATCHER alive'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`Keep-alive server running on port ${PORT}`));

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers // recommended for role/member events; enable in Dev Portal
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// ---------- Helpers ----------
function isOwner(member){ return !!member && OWNER_ROLE_ID && member.roles.cache.has(OWNER_ROLE_ID); }
function isAdmin(member){ return !!member && (member.permissions.has(PermissionsBitField.Flags.Administrator) || (ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID))); }
function isMod(member){ return !!member && (isAdmin(member) || (MOD_ROLE_ID && member.roles.cache.has(MOD_ROLE_ID))); }
function isStaff(member){ return !!member && (isMod(member) || (STAFF_ROLE_ID && member.roles.cache.has(STAFF_ROLE_ID))); }

async function logTo(channelId, content){ try{ const ch = await client.channels.fetch(channelId).catch(()=>null); if(ch) ch.send(content).catch(()=>{}); }catch(e){} }
function pickWinners(entries, count){ const winners=[]; const pool=Array.from(entries); while(winners.length<count && pool.length>0){ const i=Math.floor(Math.random()*pool.length); winners.push(pool.splice(i,1)[0]); } return winners; }

// ---------- Command Registration (auto) ----------
async function registerCommands(){
  const cmds = [
    new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
    new SlashCommandBuilder().setName('gstart').setDescription('Start giveaway (staff only)')
      .addStringOption(o=>o.setName('duration').setDescription('10s/1m/1h/1d').setRequired(true))
      .addIntegerOption(o=>o.setName('winners').setDescription('Winners').setRequired(true))
      .addStringOption(o=>o.setName('prize').setDescription('Prize text').setRequired(true)),
    new SlashCommandBuilder().setName('ban').setDescription('Ban user (admin only)').addUserOption(o=>o.setName('user').setRequired(true)).addStringOption(o=>o.setName('reason')),
    new SlashCommandBuilder().setName('kick').setDescription('Kick user (admin only)').addUserOption(o=>o.setName('user').setRequired(true)).addStringOption(o=>o.setName('reason')),
    new SlashCommandBuilder().setName('mute').setDescription('Mute user (staff+)').addUserOption(o=>o.setName('user').setRequired(true)).addStringOption(o=>o.setName('duration')).addStringOption(o=>o.setName('reason')),
    new SlashCommandBuilder().setName('unmute').setDescription('Unmute user (staff+)').addUserOption(o=>o.setName('user').setRequired(true)),
    new SlashCommandBuilder().setName('warn').setDescription('Warn a user (mod+)').addUserOption(o=>o.setName('user').setRequired(true)).addStringOption(o=>o.setName('reason')),
    new SlashCommandBuilder().setName('infractions').setDescription('Show user infractions').addUserOption(o=>o.setName('user')),
    new SlashCommandBuilder().setName('userinfo').setDescription('User info').addUserOption(o=>o.setName('user')),
    new SlashCommandBuilder().setName('role-add').setDescription('Add role to member').addUserOption(o=>o.setName('user').setRequired(true)).addRoleOption(o=>o.setName('role').setRequired(true)),
    new SlashCommandBuilder().setName('role-remove').setDescription('Remove role from member').addUserOption(o=>o.setName('user').setRequired(true)).addRoleOption(o=>o.setName('role').setRequired(true)),
    new SlashCommandBuilder().setName('role-create').setDescription('Create a new role').addStringOption(o=>o.setName('name').setRequired(true)).addStringOption(o=>o.setName('color')),
    new SlashCommandBuilder().setName('role-delete').setDescription('Delete a role').addRoleOption(o=>o.setName('role').setRequired(true)),
    new SlashCommandBuilder().setName('clear').setDescription('Bulk delete messages (mod+)').addIntegerOption(o=>o.setName('amount').setRequired(true))
  ].map(c=>c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    if (process.env.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: cmds });
      console.log('✅ Registered guild commands');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: cmds });
      console.log('✅ Registered global commands (may take 1 hour)');
    }
  } catch (e) {
    console.error('Register commands failed', e);
  }
}

// ---------- READY ----------
client.once('ready', async () => {
  console.log('✅ Logged in as', client.user.tag);
  client.user.setActivity('FSG WATCHER', { type: 2 });
  await registerCommands().catch(console.error);
});

// ---------- Slash Handling ----------
client.on('interactionCreate', async inter => {
  if (!inter.isChatInputCommand()) return;
  const cmd = inter.commandName;

  // ping
  if (cmd === 'ping') return inter.reply(`🏓 Pong! ${client.ws.ping}ms`);

  // gstart
  if (cmd === 'gstart') {
    if (!isStaff(inter.member)) return inter.reply({ content: '❌ Only staff can start giveaways', ephemeral: true });
    const duration = inter.options.getString('duration');
    const winners = inter.options.getInteger('winners');
    const prize = inter.options.getString('prize');
    const durMs = ms(duration);
    if (!durMs) return inter.reply({ content: 'Invalid duration', ephemeral: true });

    const chId = GIVEAWAY_CHANNELS[0] || inter.channelId;
    const ch = await client.channels.fetch(chId).catch(()=>null);
    if (!ch) return inter.reply({ content: 'Giveaway channel not found', ephemeral: true });

    const embed = new EmbedBuilder().setTitle('🎉 New Giveaway!').setDescription(`**Prize:** ${prize}\n**Winners:** ${winners}\nReact with 🎉 to enter!`).setColor('Gold').setFooter({ text: `Hosted by ${inter.user.tag}` }).setTimestamp(Date.now() + durMs);
    const msg = await ch.send({ embeds: [embed] });
    await msg.react('🎉');

    // store giveaway (db or json)
    if (GiveawayModel) {
      await GiveawayModel.create({ messageId: msg.id, channelId: ch.id, prize, winners, endsAt: new Date(Date.now() + durMs), hostId: inter.user.id }).catch(()=>{});
    } else {
      const all = readJSON('giveaways');
      all[msg.id] = { channel: ch.id, prize, winners, endsAt: Date.now() + durMs, hostId: inter.user.id };
      writeJSON('giveaways', all);
    }

    setTimeout(async () => {
      try {
        const fetched = await ch.messages.fetch(msg.id).catch(()=>null);
        const reaction = fetched?.reactions?.cache?.get('🎉');
        const users = reaction ? await reaction.users.fetch().catch(()=>new Map()) : new Map();
        const entries = Array.from(users.values()).filter(u => !u.bot).map(u => u.id);
        if (!entries.length) {
          ch.send('No valid entries.');
          if (GiveawayModel) await GiveawayModel.deleteOne({ messageId: msg.id }).catch(()=>{});
          else { const g = readJSON('giveaways'); delete g[msg.id]; writeJSON('giveaways', g); }
          return;
        }
        const winnerIds = pickWinners(entries, winners);
        const winnersText = winnerIds.map(id=>`<@${id}>`).join(', ');
        ch.send({ embeds: [ new EmbedBuilder().setTitle('🎉 Giveaway Ended').setDescription(`Prize: ${prize}\nWinners: ${winnersText}`).setColor('Green') ]});
        if (GiveawayModel) await GiveawayModel.deleteOne({ messageId: msg.id }).catch(()=>{});
        else { const g = readJSON('giveaways'); delete g[msg.id]; writeJSON('giveaways', g); }
      } catch(e){}
    }, durMs);

    return inter.reply({ content: `🎉 Giveaway started in ${ch}`, ephemeral: true });
  }

  // ban
  if (cmd === 'ban') {
    if (!isAdmin(inter.member)) return inter.reply({ content: '❌ Admins only', ephemeral: true });
    const user = inter.options.getUser('user'); const reason = inter.options.getString('reason') || 'No reason';
    try {
      const member = await inter.guild.members.fetch(user.id).catch(()=>null);
      if (!member) return inter.reply({ content: 'Member not found', ephemeral: true });
      await member.ban({ reason }).catch(e=>{ throw e; });
      inter.reply({ content: `✅ Banned ${user.tag}` });
      logTo(BANLOG_CHANNEL, `🔨 ${inter.user.tag} banned ${user.tag} • ${reason}`);
    } catch (e) {
      return inter.reply({ content: `Failed: ${e.message}`, ephemeral: true });
    }
  }

  // kick
  if (cmd === 'kick') {
    if (!isAdmin(inter.member)) return inter.reply({ content: '❌ Admins only', ephemeral: true });
    const user = inter.options.getUser('user'); const reason = inter.options.getString('reason') || 'No reason';
    try {
      const member = await inter.guild.members.fetch(user.id).catch(()=>null);
      if (!member) return inter.reply({ content: 'Member not found', ephemeral: true });
      await member.kick(reason).catch(e=>{ throw e; });
      inter.reply({ content: `✅ Kicked ${user.tag}` });
      logTo(BANLOG_CHANNEL, `👢 ${inter.user.tag} kicked ${user.tag} • ${reason}`);
    } catch (e) {
      return inter.reply({ content: `Failed: ${e.message}`, ephemeral: true });
    }
  }

  // mute (uses MUTE_ROLE_ID)
  if (cmd === 'mute') {
    if (!isStaff(inter.member)) return inter.reply({ content: '❌ Staff only', ephemeral: true });
    const user = inter.options.getUser('user'); const dur = inter.options.getString('duration'); const reason = inter.options.getString('reason') || 'No reason';
    try {
      const member = await inter.guild.members.fetch(user.id).catch(()=>null);
      if (!member) return inter.reply({ content: 'Member not found', ephemeral: true });
      const muteRole = inter.guild.roles.cache.get(MUTE_ROLE_ID);
      if (!muteRole) return inter.reply({ content: `Mute role not found (set MUTE_ROLE_ID)`, ephemeral: true });
      await member.roles.add(muteRole).catch(e=>{ throw e; });
      if (dur) {
        const msDur = ms(dur);
        if (msDur) setTimeout(()=>{ member.roles.remove(muteRole).catch(()=>{}); }, msDur);
      }
      inter.reply({ content: `🔇 Muted ${user.tag} • ${reason}` });
      logTo(MESSAGELOG_CHANNEL, `🔇 ${inter.user.tag} muted ${user.tag} • ${reason}`);
    } catch (e) {
      return inter.reply({ content: `Failed: ${e.message}`, ephemeral: true });
    }
  }

  // unmute
  if (cmd === 'unmute') {
    if (!isStaff(inter.member)) return inter.reply({ content: '❌ Staff only', ephemeral: true });
    const user = inter.options.getUser('user');
    try {
      const member = await inter.guild.members.fetch(user.id).catch(()=>null);
      if (!member) return inter.reply({ content: 'Member not found', ephemeral: true });
      const muteRole = inter.guild.roles.cache.get(MUTE_ROLE_ID);
      if (!muteRole) return inter.reply({ content: `Mute role not found (set MUTE_ROLE_ID)`, ephemeral: true });
      await member.roles.remove(muteRole).catch(e=>{ throw e; });
      inter.reply({ content: `🔊 Unmuted ${user.tag}` });
    } catch (e) {
      return inter.reply({ content: `Failed: ${e.message}`, ephemeral: true });
    }
  }

  // warn
  if (cmd === 'warn') {
    if (!isMod(inter.member)) return inter.reply({ content: '❌ Mods only', ephemeral: true });
    const user = inter.options.getUser('user'); const reason = inter.options.getString('reason') || 'No reason';
    const payload = { guildId: inter.guild.id, userId: user.id, byId: inter.user.id, reason, at: new Date() };
    if (WarningModel) {
      await WarningModel.create(payload).catch(()=>{});
    } else {
      const w = readJSON('warnings');
      w[user.id] = w[user.id] || [];
      w[user.id].push(payload);
      writeJSON('warnings', w);
    }
    inter.reply({ content: `⚠️ Warned ${user.tag}`, ephemeral: true });
    logTo(MESSAGELOG_CHANNEL, `⚠️ ${inter.user.tag} warned ${user.tag} • ${reason}`);
  }

  // infractions
  if (cmd === 'infractions') {
    const user = inter.options.getUser('user') || inter.user;
    let list = [];
    if (WarningModel) {
      list = await WarningModel.find({ guildId: inter.guild.id, userId: user.id }).catch(()=>[]);
    } else {
      const w = readJSON('warnings');
      list = w[user.id] || [];
    }
    if (!list || list.length === 0) return inter.reply({ content: `${user.tag} has no warnings.`, ephemeral: true });
    const desc = list.map((w,i)=>`${i+1}. <@${w.byId || w.by}> • ${w.reason} • <t:${Math.floor(new Date(w.at).getTime()/1000)}:R>`).join('\n');
    const embed = new EmbedBuilder().setTitle(`${user.tag} — Warnings`).setDescription(desc).setColor('Orange');
    return inter.reply({ embeds: [embed], ephemeral: true });
  }

  // userinfo
  if (cmd === 'userinfo') {
    const user = inter.options.getUser('user') || inter.user;
    const member = await inter.guild.members.fetch(user.id).catch(()=>null);
    const embed = new EmbedBuilder().setTitle(user.tag).setThumbnail(user.displayAvatarURL({ dynamic:true })).addFields(
      { name: 'ID', value: user.id, inline: true },
      { name: 'Joined', value: member ? `<t:${Math.floor(member.joinedTimestamp/1000)}:R>` : 'N/A', inline: true }
    );
    return inter.reply({ embeds: [embed] });
  }

  // role-add
  if (cmd === 'role-add') {
    if (!isStaff(inter.member)) return inter.reply({ content: '❌ Staff only', ephemeral: true });
    const user = inter.options.getUser('user'); const role = inter.options.getRole('role');
    try {
      const member = await inter.guild.members.fetch(user.id).catch(()=>null);
      if (!member) return inter.reply({ content: 'Member not found', ephemeral: true });
      await member.roles.add(role).catch(e=>{ throw e; });
      inter.reply({ content: `✅ Added ${role.name} to ${user.tag}` });
      logTo(MESSAGELOG_CHANNEL, `🟢 ${inter.user.tag} added ${role.name} to ${user.tag}`);
    } catch (e) { return inter.reply({ content: `Failed: ${e.message}`, ephemeral: true }); }
  }

  // role-remove
  if (cmd === 'role-remove') {
    if (!isStaff(inter.member)) return inter.reply({ content: '❌ Staff only', ephemeral: true });
    const user = inter.options.getUser('user'); const role = inter.options.getRole('role');
    try {
      const member = await inter.guild.members.fetch(user.id).catch(()=>null);
      if (!member) return inter.reply({ content: 'Member not found', ephemeral: true });
      await member.roles.remove(role).catch(e=>{ throw e; });
      inter.reply({ content: `✅ Removed ${role.name} from ${user.tag}` });
      logTo(MESSAGELOG_CHANNEL, `🔴 ${inter.user.tag} removed ${role.name} from ${user.tag}`);
    } catch (e) { return inter.reply({ content: `Failed: ${e.message}`, ephemeral: true }); }
  }

  // role-create
  if (cmd === 'role-create') {
    if (!isAdmin(inter.member)) return inter.reply({ content: '❌ Admin only', ephemeral: true });
    const name = inter.options.getString('name'); const color = inter.options.getString('color') || null;
    try {
      const role = await inter.guild.roles.create({ name, color }).catch(e=>{ throw e; });
      inter.reply({ content: `✅ Created role ${role.name}` });
      logTo(MESSAGELOG_CHANNEL, `🔧 ${inter.user.tag} created role ${role.name}`);
    } catch (e) { return inter.reply({ content: `Failed: ${e.message}`, ephemeral: true }); }
  }

  // role-delete
  if (cmd === 'role-delete') {
    if (!isAdmin(inter.member)) return inter.reply({ content: '❌ Admin only', ephemeral: true });
    const role = inter.options.getRole('role');
    if (role.managed) return inter.reply({ content: 'Cannot delete managed role', ephemeral: true });
    try {
      await role.delete().catch(e=>{ throw e; });
      inter.reply({ content: `✅ Deleted role ${role.name}` });
      logTo(MESSAGELOG_CHANNEL, `🗑️ ${inter.user.tag} deleted role ${role.name}`);
    } catch (e) { return inter.reply({ content: `Failed: ${e.message}`, ephemeral: true }); }
  }

  // clear
  if (cmd === 'clear') {
    if (!isMod(inter.member)) return inter.reply({ content: '❌ Mods only', ephemeral: true });
    const amount = inter.options.getInteger('amount') || 10;
    try {
      const deleted = await inter.channel.bulkDelete(Math.min(100, amount), true);
      return inter.reply({ content: `🧹 Deleted ${deleted.size} messages.`, ephemeral: true });
    } catch (e) { return inter.reply({ content: `Failed: ${e.message}`, ephemeral: true }); }
  }
});

// ---------- Prefix fallback (for convenience) ----------
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/g);
  const cmd = args.shift().toLowerCase();

  // !ping
  if (cmd === 'ping') return message.reply(`🏓 Pong! ${client.ws.ping}ms`);

  // !gstart <duration> <winners> <prize...>
  if (cmd === 'gstart') {
    if (!isStaff(message.member)) return message.reply('❌ Only staff can start giveaways.');
    const duration = args.shift(); const winners = parseInt(args.shift() || '1'); const prize = args.join(' ');
    if (!duration || !prize) return message.reply('Usage: !gstart <duration> <winners> <prize>');
    const msDur = ms(duration); if (!msDur) return message.reply('Invalid duration format.');
    c
