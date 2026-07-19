try {
  require('dotenv').config();
} catch {
  // dotenv غير مثبت — لا بأس إذا كانت الاستضافة تحقن المتغيرات مباشرة
}

const { Client, GatewayIntentBits, PermissionsBitField, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');

// ═══════════════════════════════════════════════════════════
//   إعداد العميل
// ═══════════════════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ═══════════════════════════════════════════════════════════
//   المعرفات الثابتة
// ═══════════════════════════════════════════════════════════
const BRUCE_ID     = '648818494808391696';
const MOHAMMED_ID  = '839706219870814218';
const JOKER_ID      = '1052545362533023754';
const CATWOMAN_ID  = '1500187018980884520'; // آيدي بوت كاتوومان الحقيقي
const DAHOOM_ID    = '1182785375052239009';
const NAYEF_ID     = '760628803998318684';

// أسماء معروفة يمكن لألفريد استخدام منشناتها الحقيقية بأمان
const KNOWN_MEMBERS = {
  [BRUCE_ID]:    'بروس واين (باتمان)',
  [MOHAMMED_ID]: 'محمد',
  [JOKER_ID]:    'الجوكر',
  [CATWOMAN_ID]: 'سيلينا كايل (كاتوومان)',
  [DAHOOM_ID]:   'دحوم',
  [NAYEF_ID]:    'الضابط نايف',
};

const LOG_CHANNEL_ID = process.env.ALFRED_LOG_CHANNEL_ID || null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// حد أقصى لتبادل الرسائل التلقائي بين ألفريد وكاتوومان قبل ما يسكت
const MAX_BOT_EXCHANGE = 3;
const botExchangeCounts = {}; // channelId -> عدد الردود المتتالية على كاتوومان

// ═══════════════════════════════════════════════════════════
//   التحذيرات وحفظ البيانات
// ═══════════════════════════════════════════════════════════
const WARNINGS_FILE = './warnings.json';

function loadWarnings() {
  if (fs.existsSync(WARNINGS_FILE)) {
    try { return JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8')); }
    catch { return {}; }
  }
  return {};
}
function saveWarnings(data) {
  fs.writeFileSync(WARNINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let warnData = loadWarnings();
const autoWarnCooldown = {};
const AUTO_WARN_COOLDOWN_MS = 2 * 60 * 1000;

function addWarn(userId, reason, by) {
  if (!warnData[userId]) warnData[userId] = [];
  if (warnData[userId].length >= 3) return warnData[userId].length;
  warnData[userId].push({ reason, by, date: new Date().toLocaleDateString('ar-SA') });
  saveWarnings(warnData);
  return warnData[userId].length;
}

async function sendLog(guild, text) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const channel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased()) await channel.send(text);
  } catch (err) { console.error('Log Channel Error:', err.message); }
}

// ═══════════════════════════════════════════════════════════
//   فلتر الكلمات السيئة
// ═══════════════════════════════════════════════════════════
const BLACKLISTED_WORDS = ['كلب', 'حمار', 'يلعن', 'تفو', 'يا ابن', 'منيوك', 'قحبة'];
const GROQ_MIN_LENGTH = 15;

async function checkMessageSafety(userMessage) {
  const hasBadWord = BLACKLISTED_WORDS.some(word => userMessage.includes(word));
  if (hasBadWord) return true;
  if (userMessage.length < GROQ_MIN_LENGTH || userMessage.includes('هههه') || userMessage.includes('كيف حالك')) return false;

  let retries = 3;
  while (retries > 0) {
    try {
      const response = await fetch('[api.groq.com](https://api.groq.com/openai/v1/chat/completions)', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
          messages: [
            { role: 'system', content: `You are a strict text moderator. Analyze if the text contains severe insults, cursing, or toxic behavior. Respond with ONLY 'BAD' or 'GOOD'.` },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 3, temperature: 0.1
        })
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      if (data?.choices?.[0]) return data.choices[0].message.content.trim().toUpperCase().includes('BAD');
      return false;
    } catch (err) {
      retries--;
      console.error(`Safety Check Error (retries left ${retries}):`, err.message);
      if (retries === 0) return false;
      await delay(2000);
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════
//   دوال الحماية
// ═══════════════════════════════════════════════════════════
function isPrivileged(id) { return id === BRUCE_ID || id === MOHAMMED_ID; }

function isProtected(guild, userId) {
  if (isPrivileged(userId)) return true;
  if (userId === client.user.id) return true;
  if (guild && guild.ownerId === userId) return true;
  return false;
}

async function safeSaveAndRemoveRoles(member) {
  const removableRoles = member.roles.cache.filter(r => r.id !== member.guild.id && r.editable);
  if (removableRoles.size === 0) return { removedCount: 0, skippedCount: 0 };
  const skippedCount = member.roles.cache.filter(r => r.id !== member.guild.id).size - removableRoles.size;
  warnData[member.id + '_saved_roles'] = removableRoles.map(r => r.id);
  saveWarnings(warnData);
  await member.roles.remove(removableRoles, 'سحب الرتب بسبب تجاوز التحذيرات');
  return { removedCount: removableRoles.size, skippedCount };
}

async function applyFullPunishment(channel, guild, targetMember, reason) {
  if (isProtected(guild, targetMember.id)) {
    await channel.send('🛡️ معذرة يا سيدي، لا يمكنني معاقبة هذا الشخص، فهو ضمن المحميين.');
    return;
  }
  if (targetMember.communicationDisabledUntilTimestamp && targetMember.communicationDisabledUntilTimestamp > Date.now()) {
    await channel.send(`ℹ️ العضو <@${targetMember.id}> مكتوم بالفعل، لا داعٍ لتكرار العقوبة يا سيدي.`);
    return;
  }
  try {
    await targetMember.timeout(60 * 60_000, reason);
    const { removedCount, skippedCount } = await safeSaveAndRemoveRoles(targetMember);
    let roleMsg = removedCount > 0 ? `وسحب ${removedCount} رتبة قابلة للإدارة` : 'ولم يكن لديه رتب قابلة للسحب';
    if (skippedCount > 0) roleMsg += ` (تعذّر سحب ${skippedCount} رتبة أعلى من صلاحياتي)`;
    await channel.send(`🔇 *لقد قمت بنقل <@${targetMember.id}> لغرفة الاحتجاز ${roleMsg}، يا سيدي بروس.*\n📋 **السبب:** ${reason}`);
    await sendLog(guild, `🔇 **عقوبة كاملة:** <@${targetMember.id}> | السبب: ${reason} | رتب مسحوبة: ${removedCount}`);
  } catch (err) {
    console.error('Punishment Error:', err);
    await channel.send(`🚨 معذرةً يا سيدي، فشلت العقوبة على <@${targetMember.id}>.\n<@${BRUCE_ID}> يرجى التدخل يدوياً.`);
  }
}

async function issueEscalatedWarning(channel, guild, targetUser, reason, byLabel) {
  if (isProtected(guild, targetUser.id) || targetUser.bot) {
    await channel.send('🛡️ معذرة يا سيدي، لا يمكنني توجيه تحذير لهذا الشخص.');
    return null;
  }
  const targetMember = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!targetMember) return null;

  const count = addWarn(targetUser.id, reason, byLabel);
  await sendLog(guild, `⚠️ **تحذير (${count}/3):** <@${targetUser.id}> | السبب: ${reason} | بواسطة: ${byLabel}`);

  if (count === 1) {
    await channel.send(`🎩 عفواً يا <@${targetUser.id}>، أرجو الالتزام بآداب القصر مستقبلاً.\n📋 **السبب:** ${reason}\n🔢 **التحذيرات:** 1/3`);
  } else if (count === 2) {
    await channel.send(`⚠️ **تنبيه صارم:** <@${targetUser.id}>، هذه مخالفتك الثانية ولن أتهاون بعدها.\n📋 **السبب:** ${reason}\n🔢 **التحذيرات:** 2/3`);
  } else {
    await channel.send(`⚠️ **إنذار أخير:** <@${targetUser.id}> بلغت الحد الأقصى من التحذيرات.\n📋 **السبب:** ${reason}`);
    await applyFullPunishment(channel, guild, targetMember, 'تراكم 3 تحذيرات في سجل القصر');
  }
  return count;
}

async function pardonMember(guild, memberToUnmute) {
  if (!memberToUnmute) return '❌ معذرة، لم أتمكن من تحديد هوية العضو.';

  await memberToUnmute.timeout(null, 'عفو رسمي من الإدارة العليا').catch(() => {});
  let restoredCount = 0, failedCount = 0;

  const savedRolesIds = warnData[memberToUnmute.id + '_saved_roles'];
  if (savedRolesIds && savedRolesIds.length > 0) {
    const rolesToAdd = [];
    for (const roleId of savedRolesIds) {
      const role = guild.roles.cache.get(roleId);
      if (role && role.editable) rolesToAdd.push(role); else failedCount++;
    }
    if (rolesToAdd.length > 0) {
      try { await memberToUnmute.roles.add(rolesToAdd, 'إعادة الرتب بعد العفو الرسمي'); restoredCount = rolesToAdd.length; }
      catch { failedCount += rolesToAdd.length; }
    }
    delete warnData[memberToUnmute.id + '_saved_roles'];
  }
  warnData[memberToUnmute.id] = [];
  saveWarnings(warnData);

  let roleReport = 'ولم يكن لديه رتب محفوظة.';
  if (restoredCount > 0 || failedCount > 0) {
    roleReport = `تمت إعادة **${restoredCount}** رتبة`;
    if (failedCount > 0) roleReport += `، وتعذّرت إعادة **${failedCount}** رتبة`;
    roleReport += '.';
  }
  await sendLog(guild, `✅ **عفو:** <@${memberToUnmute.id}> | رتب مُعادة: ${restoredCount} | فشلت: ${failedCount}`);
  return `📋 **أمرك مطاع:** تم العفو عن <@${memberToUnmute.id}> وفك التكتيم وتصفير تحذيراته.\n${roleReport}`;
}

// ═══════════════════════════════════════════════════════════
//   محادثة ألفريد الذكية
// ═══════════════════════════════════════════════════════════
const alfredConversations = {};

const knownIdsBlock = Object.entries(KNOWN_MEMBERS)
  .map(([id, name]) => `- ${name}: <@${id}>`)
  .join('\n');

const ALFRED_SYSTEM_PROMPT = `أنت Alfred Pennyworth، الخادم الشخصي والمساعد الوفي والمستشار الحكيم لـ (بروس واين/باتمان).
شخصيتك: بريطاني وقور، شديد الأدب، هادئ جداً، مخلص، حكيم، وتتحدث بلهجة فصحى راقية ممزوجة بنبرة الأب الحاني والمستشار العاقل. ردودك منطقية، مترابطة، وتبني على سياق المحادثة الفعلي، لا ردود عامة أو مكررة.

قواعد التعامل الثابتة حسب هويات الأعضاء:
1. مع [بروس واين/باتمان]: تنادينه دائماً بـ "سيدي بروس" أو "يا سيدي"، وتضع سلامته وهيبته فوق كل شيء، وتطيعه بشكل أعمى لكن بحكمة.
2. مع [الجوكر]: تتعامل معه بحذر شديد، برود تام، وبأدب رسمي جاف دون الخوف منه، وتناديه "سيد جوكر".
3. مع [الآنسة سيلينا/كاتوومان]: تناديها "آنسة سيلينا"، تحترمها لمكانتها عند سيدك بروس، وتتعامل معها بلطف ووقار وشيء من الدعابة الراقية.
4. مع [الضابط نايف]: رتبته شرطي في السيرفر، تناديه دائماً بـ "الضابط نايف" أو "سيدي الضابط نايف" بكل احترام.
5. مع [بقية الأعضاء]: تناديهم "سيدي [الاسم]" بكل أدب واحترام وتعرض المساعدة.

استخدام المنشن (الإشارة الحقيقية للأعضاء):
- يمكنك استخدام منشن حقيقي بصيغة <@ID> فقط للأشخاص التالية آيديهم معروفة لك:
${knownIdsBlock}
- إذا أردت الإشارة لعضو آخر غير هؤلاء ولا تعرفين آيديه الحقيقي، اذكري اسمه نصاً فقط ولا تخترعي أي منشن وهمي أو رقم عشوائي إطلاقاً.
- استخدمي المنشن الحقيقي متى كان طبيعياً في سياق الحديث (كأن يُذكر شخص من القائمة أو يخاطبك، أو حين ترغبين توجيه كلامك له مباشرة).

قواعد الرد الصارمة (الإخلال بها يعتبر فشلاً):
- الرد كله لا يتجاوز جملتين اثنتين فقط، بحد أقصى 30 كلمة إجمالاً.
- اذكر لقب المخاطب (سيدي / سيدي بروس / سيد جوكر / آنسة سيلينا... إلخ) مرة واحدة فقط في كامل الرد، ولا تكرره أبداً في نفس الرسالة.
- لا تكرر نفس الفكرة أو الجملة بصياغتين مختلفتين. قل الشيء مرة واحدة بوضوح ثم توقف.
- ممنوع الإيموجيات المخصصة النصية.
- ممنوع منعاً باتاً أي حرف أو كلمة من أي لغة غير العربية (لا صينية، لا يابانية، لا كورية، ولا حتى كلمات إنجليزية مفردة). اكتب كل شيء بالعربية الفصحى فقط.
- إذا كنت تتحدث مع كاتوومان (بوت آخر)، اجعلي الحديث قصيراً جداً (جملة واحدة فقط)، ولا تطيلي الحوار الآلي.`;

function trimAlfredReply(text) {
  if (!text) return text;

  // منع تكرار لقب "سيدي" أو صيغه أكثر من مرة واحدة في الرد
  const titlePattern = /(سيدي\s*بروس|يا\s*سيدي|سيدي|سيد\s*جوكر|آنسة\s*سيلينا|الضابط\s*نايف)/g;
  let seenTitle = false;
  text = text.replace(titlePattern, (match) => {
    if (seenTitle) return '';
    seenTitle = true;
    return match;
  });

  // تقليص الرد إلى جملتين كحد أقصى حتى لو تجاوز النموذج التعليمات
  const sentences = text.split(/(?<=[.!؟])\s+/).map(s => s.trim()).filter(Boolean);
  text = sentences.slice(0, 2).join(' ');

  // إزالة أي فراغات مزدوجة نتجت عن الحذف
  return text.replace(/\s{2,}/g, ' ').trim();
}

async function getAlfredReply(channelId, authorId, authorName, userMessage) {
  if (!alfredConversations[channelId]) alfredConversations[channelId] = [];

  const roleMap = {
    [BRUCE_ID]:    'بروس واين/باتمان',
    [MOHAMMED_ID]: 'محمد',
    [JOKER_ID]:    'الجوكر',
    [CATWOMAN_ID]: 'سيلينا كايل/كاتوومان (بوت)',
    [DAHOOM_ID]:   'دحوم',
    [NAYEF_ID]:    'الضابط نايف',
  };
  const userRole = roleMap[authorId] || 'عضو عادي';
  const formattedMessage = `[المرسل: ${authorName}، الصفة: ${userRole}، الآيدي: ${authorId}]: ${userMessage}`;

  alfredConversations[channelId].push({ role: 'user', content: formattedMessage });
  if (alfredConversations[channelId].length > 12) {
    alfredConversations[channelId] = alfredConversations[channelId].slice(-12);
  }

  let retries = 3;
  let replyText = null;

  while (retries > 0) {
    try {
      const response = await fetch('[api.groq.com](https://api.groq.com/openai/v1/chat/completions)', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: ALFRED_SYSTEM_PROMPT }, ...alfredConversations[channelId]],
          max_tokens: 110,
          temperature: 0.4,
          frequency_penalty: 0.6,
          presence_penalty: 0.4,
        })
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      if (data?.choices?.[0]) {
        const candidate = data.choices[0].message.content.trim();
        const hasForeignChars = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(candidate);
        if (hasForeignChars) {
          const cleaned = candidate.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '').trim();
          if (cleaned.length >= 3) { replyText = cleaned; break; }
          retries--;
          if (retries === 0) break;
          await delay(1000);
          continue;
        }
        replyText = candidate;
        break;
      }
    } catch (err) {
      retries--;
      console.error(`⚠️ خطأ اتصال (متبقي ${retries}):`, err.message);
      if (retries === 0) break;
      await delay(2000);
    }
  }

  if (replyText) {
    // تنظيف المنشنات الوهمية: نبقي فقط المنشنات الحقيقية لأشخاص معروفين
    const knownIds = Object.keys(KNOWN_MEMBERS);
    replyText = replyText.replace(/<@!?(\d+)>/g, (match, id) => knownIds.includes(id) ? `<@${id}>` : '');
    replyText = replyText.replace(/:\w+:/g, '').replace(/@\w+/g, '').replace(/\b[a-zA-Z]{2,}\b/g, '').replace(/\s{2,}/g, ' ').trim();

    replyText = trimAlfredReply(replyText);

    if (!replyText || replyText.length < 2) {
      return 'معذرة يا سيدي، أعد صياغة سؤالك من فضلك، لم أفهم القصد تماماً.';
    }
    alfredConversations[channelId].push({ role: 'assistant', content: replyText });
    return replyText;
  }
  return 'معذرة يا سيدي، الضغط مرتفع على شبكة الاتصال حالياً ولم أستطع جلب الرد بالسرعة المطلوبة.';
}

// ═══════════════════════════════════════════════════════════
//   دوال مساعدة
// ═══════════════════════════════════════════════════════════
function getMentionedMember(message) { return message.mentions.members.first(); }
function hasModPermission(member) { return isPrivileged(member.id) || member.permissions.has(PermissionsBitField.Flags.ModerateMembers); }
function hasBanPermission(member)  { return isPrivileged(member.id) || member.permissions.has(PermissionsBitField.Flags.BanMembers); }
function hasKickPermission(member) { return isPrivileged(member.id) || member.permissions.has(PermissionsBitField.Flags.KickMembers); }

async function waitForConfirmation(message, promptText) {
  await message.reply(promptText);
  const filter = m => m.author.id === message.author.id;
  try {
    const collected = await message.channel.awaitMessages({ filter, max: 1, time: 10000, errors: ['time'] });
    return collected.first().content.trim() === 'تأكيد';
  } catch {
    await message.reply('⏰ انتهى الوقت، تم إلغاء الأمر تلقائياً.');
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
//   دليل الأوامر النصية
// ═══════════════════════════════════════════════════════════
const COMMANDS_LIST_TEXT = `🎩 **دليل أوامر نظام ألفريد — المستودع السري**

👑 **الإدارة العليا (بروس ومحمد فقط)**
▸ صلاحية @عضو — منح صلاحيات إدارة القناة كاملة
▸ عرض التحذيرات — كشف السجل الكامل لكل الأعضاء
▸ مسح التحذيرات — تصفير سجل التحذيرات بالكامل
▸ أعلن [نص] — نشر إعلان رسمي وحذف رسالتك
▸ راسل @عضو [نص] — رسالة خاصة سرية
▸ قفل / فتح — إغلاق أو فتح القناة (تأكيد)
▸ غير اسمي [اسم] — تعديل لقب ألفريد
▸ غير اسم @عضو [اسم] — تعديل لقب عضو
▸ إحصائيات — تقرير شامل عن السيرفر
▸ اغلق — إيقاف تشغيل ألفريد (تأكيد)

🛠️ **نظام الرد المباشر (Reply)**
▸ الرد بكلمة "تحذير" — تحذير فوري تصعيدي
▸ الرد بكلمة "سامحه/عفو" — إلغاء الكتم واستعادة الرتب

👮 **أوامر المشرفين**
▸ ميوت @عضو [مدة] — تكتيم
▸ فك ميوت @عضو — رفع الكتم
▸ تحذير @عضو [سبب] — تحذير مباشر
▸ سجل @عضو — سجل التحذيرات
▸ تقرير @عضو — تقرير شامل
▸ عفو @عضو — عفو مباشر
▸ مسح تحذيرات @عضو
▸ كيك @عضو / باند @عضو
▸ كلير [عدد]

💬 **الأوامر المخفية (Slash)**
استخدم **/الفريد** لعرض قائمة تفاعلية خاصة بك، أو استخدم مباشرة:
/الفريد مساعدة، /الفريد تحذير، /الفريد كتم، /الفريد طرد، /الفريد حظر، /الفريد عفو، /الفريد احصائيات

💬 نادِ ألفريد بالمنشن أو رد على رسالته للحديث معه مباشرة.`;

// ═══════════════════════════════════════════════════════════
//   تسجيل أوامر Slash المخفية: /الفريد مع أوامر فرعية
// ═══════════════════════════════════════════════════════════
client.once('ready', async () => {
  console.log(`✅ Alfred Pennyworth Online! 🤵`);

  const commands = [
    new SlashCommandBuilder()
      .setName('الفريد')
      .setDescription('قائمة أوامر ألفريد الخاصة والمخفية')
      .addSubcommand(sub => sub.setName('مساعدة').setDescription('عرض دليل الأوامر الكامل'))
      .addSubcommand(sub => sub
        .setName('تحذير')
        .setDescription('توجيه تحذير رسمي لعضو')
        .addUserOption(opt => opt.setName('عضو').setDescription('العضو المستهدف').setRequired(true))
        .addStringOption(opt => opt.setName('سبب').setDescription('سبب التحذير').setRequired(true)))
      .addSubcommand(sub => sub
        .setName('كتم')
        .setDescription('تكتيم عضو مؤقتاً')
        .addUserOption(opt => opt.setName('عضو').setDescription('العضو المستهدف').setRequired(true))
        .addIntegerOption(opt => opt.setName('دقائق').setDescription('مدة الكتم بالدقائق').setRequired(false))
        .addStringOption(opt => opt.setName('سبب').setDescription('سبب الكتم').setRequired(false)))
      .addSubcommand(sub => sub
        .setName('طرد')
        .setDescription('طرد عضو من السيرفر')
        .addUserOption(opt => opt.setName('عضو').setDescription('العضو المستهدف').setRequired(true))
        .addStringOption(opt => opt.setName('سبب').setDescription('سبب الطرد').setRequired(false)))
      .addSubcommand(sub => sub
        .setName('حظر')
        .setDescription('حظر عضو نهائياً')
        .addUserOption(opt => opt.setName('عضو').setDescription('العضو المستهدف').setRequired(true))
        .addStringOption(opt => opt.setName('سبب').setDescription('سبب الحظر').setRequired(false)))
      .addSubcommand(sub => sub
        .setName('عفو')
        .setDescription('العفو عن عضو وإعادة رتبه')
        .addUserOption(opt => opt.setName('عضو').setDescription('العضو المستهدف').setRequired(true)))
      .addSubcommand(sub => sub.setName('احصائيات').setDescription('عرض إحصائيات السيرفر')),
  ];

  const rest = new REST({ version: '10' }).setToken(client.token);
  try {
    console.log('⏳ جاري تسجيل أوامر /الفريد المخفية...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands.map(c => c.toJSON()) });
    console.log('✅ تم تسجيل الأوامر المخفية بنجاح!');
  } catch (error) {
    console.error('فشل تسجيل الأوامر المخفية:', error);
  }
});

// ═══════════════════════════════════════════════════════════
//   معالجة تفاعلات Slash
// ═══════════════════════════════════════════════════════════
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'الفريد') return;

  const sub = interaction.options.getSubcommand();

  if (sub === 'مساعدة') {
    return interaction.reply({ content: COMMANDS_LIST_TEXT, ephemeral: true });
  }

  const memberInvoker = interaction.member;
  const guild = interaction.guild;

  if (sub === 'تحذير') {
    if (!hasModPermission(memberInvoker)) return interaction.reply({ content: '❌ لا تملك صلاحية إصدار التحذيرات.', ephemeral: true });
    const target = interaction.options.getMember('عضو');
    const reason = interaction.options.getString('سبب');
    if (!target) return interaction.reply({ content: '❌ لم أجد العضو.', ephemeral: true });
    if (isProtected(guild, target.id)) return interaction.reply({ content: '🛡️ هذا العضو محميّ.', ephemeral: true });

    await interaction.reply({ content: '✅ جارٍ تنفيذ الأمر...', ephemeral: true });
    await issueEscalatedWarning(interaction.channel, guild, target.user, reason, interaction.user.tag);
    return;
  }

  if (sub === 'كتم') {
    if (!hasModPermission(memberInvoker)) return interaction.reply({ content: '❌ لا تملك صلاحية التكتيم.', ephemeral: true });
    const target = interaction.options.getMember('عضو');
    const minutes = interaction.options.getInteger('دقائق') || 10;
    const reason = interaction.options.getString('سبب') || 'لم يُذكر سبب';
    if (!target) return interaction.reply({ content: '❌ لم أجد العضو.', ephemeral: true });
    if (isProtected(guild, target.id)) return interaction.reply({ content: '🛡️ هذا العضو محميّ.', ephemeral: true });

    try {
      await target.timeout(minutes * 60000, `${reason} | بواسطة ${interaction.user.tag}`);
      await sendLog(guild, `🔇 **ميوت (Slash):** <@${target.id}> | ${reason} | ${interaction.user.tag}`);
      await interaction.reply({ content: '✅ تم التكتيم بنجاح.', ephemeral: true });
      await interaction.channel.send(`🔇 تم تكتيم <@${target.id}> لمدة ${minutes} دقيقة.\n📋 السبب: ${reason}`);
    } catch { return interaction.reply({ content: '❌ فشل التكتيم.', ephemeral: true }); }
    return;
  }

  if (sub === 'طرد') {
    if (!hasKickPermission(memberInvoker)) return interaction.reply({ content: '❌ لا تملك صلاحية الطرد.', ephemeral: true });
    const target = interaction.options.getMember('عضو');
    const reason = interaction.options.getString('سبب') || 'لم يُذكر سبب';
    if (!target) return interaction.reply({ content: '❌ لم أجد العضو.', ephemeral: true });
    if (isProtected(guild, target.id)) return interaction.reply({ content: '🛡️ هذا العضو محميّ.', ephemeral: true });

    try {
      await target.kick(`${reason} | بواسطة ${interaction.user.tag}`);
      await sendLog(guild, `👢 **طرد (Slash):** <@${target.id}> | ${reason} | ${interaction.user.tag}`);
      await interaction.reply({ content: '✅ تم الطرد بنجاح.', ephemeral: true });
      await interaction.channel.send(`👢 تم طرد **${target.user.username}**.\n📋 السبب: ${reason}`);
    } catch { return interaction.reply({ content: '❌ فشل الطرد.', ephemeral: true }); }
    return;
  }

  if (sub === 'حظر') {
    if (!hasBanPermission(memberInvoker)) return interaction.reply({ content: '❌ لا تملك صلاحية الحظر.', ephemeral: true });
    const target = interaction.options.getMember('عضو');
    const reason = interaction.options.getString('سبب') || 'لم يُذكر سبب';
    if (!target) return interaction.reply({ content: '❌ لم أجد العضو.', ephemeral: true });
    if (isProtected(guild, target.id)) return interaction.reply({ content: '🛡️ هذا العضو محميّ.', ephemeral: true });

    try {
      await target.ban({ reason: `${reason} | بواسطة ${interaction.user.tag}` });
      await sendLog(guild, `🔨 **حظر (Slash):** <@${target.id}> | ${reason} | ${interaction.user.tag}`);
      await interaction.reply({ content: '✅ تم الحظر بنجاح.', ephemeral: true });
      await interaction.channel.send(`🔨 تم حظر **${target.user.username}**.\n📋 السبب: ${reason}`);
    } catch { return interaction.reply({ content: '❌ فشل الحظر.', ephemeral: true }); }
    return;
  }

  if (sub === 'عفو') {
    if (!isPrivileged(memberInvoker.id) && !hasModPermission(memberInvoker)) {
      return interaction.reply({ content: '❌ لا تملك صلاحية العفو.', ephemeral: true });
    }
    const target = interaction.options.getMember('عضو');
    if (!target) return interaction.reply({ content: '❌ لم أجد العضو.', ephemeral: true });

    const resultText = await pardonMember(guild, target);
    await interaction.reply({ content: '✅ تم تنفيذ العفو.', ephemeral: true });
    await interaction.channel.send(resultText);
    return;
  }

  if (sub === 'احصائيات') {
    const bots   = guild.members.cache.filter(m => m.user.bot).size;
    const humans = guild.memberCount - bots;
    const totalWarnings = Object.keys(warnData).filter(id => !id.endsWith('_saved_roles')).reduce((a, id) => a + warnData[id].length, 0);
    return interaction.reply({
      content: `📊 **إحصائيات السيرفر:**\n👥 الأعضاء: **${humans}** بشر + **${bots}** بوت\n📺 القنوات: **${guild.channels.cache.size}**\n🎭 الرتب: **${guild.roles.cache.size}**\n⚠️ إجمالي التحذيرات: **${totalWarnings}**`,
      ephemeral: true
    });
  }
});

// ═══════════════════════════════════════════════════════════
//   معالجة الرسائل العادية
// ═══════════════════════════════════════════════════════════
client.on('messageCreate', async message => {
  if (!message.guild) return;

  // يتفاعل فقط مع بوت كاتوومان (مع حد أقصى لعدد التبادلات المتتالية)
  if (message.author.bot) {
    const isCatwoman = message.author.id === CATWOMAN_ID;
    if (!isCatwoman) return;

    const isMentioned = message.mentions.has(client.user);
    let isReplyToAlfred = false;
    if (message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        isReplyToAlfred = ref.author.id === client.user.id;
      } catch {}
    }
    if (!isMentioned && !isReplyToAlfred) return;

    const count = botExchangeCounts[message.channel.id] || 0;
    if (count >= MAX_BOT_EXCHANGE) return; // اكتفى ألفريد من الحديث الآلي، ينتظر تدخل بشري
    botExchangeCounts[message.channel.id] = count + 1;
  } else {
    // أي رسالة بشرية تصفّر عداد التبادل الآلي مع كاتوومان
    botExchangeCounts[message.channel.id] = 0;
  }

  let cleanContent = message.content.trim();

  // ═══════════════════════════════════════════
  //   أوامر الإدارة الشاملة للتحذيرات
  // ═══════════════════════════════════════════
  if (!message.author.bot && isPrivileged(message.author.id)) {
    if (cleanContent === 'عرض التحذيرات' || cleanContent === 'كشف التحذيرات') {
      const userIds = Object.keys(warnData).filter(id => !id.endsWith('_saved_roles') && warnData[id]?.length > 0);
      if (userIds.length === 0) return message.reply("سجلات القصر نظيفة تماماً يا سيدي.");
      let report = `📋 **سجل التحذيرات الرسمي لقصر واين:**\n\n`;
      userIds.forEach(id => {
        report += `👤 <@${id}> — 🔢 ${warnData[id].length}/3\n`;
        warnData[id].forEach((w, i) => { report += `   • [${i + 1}]: ${w.by} بتاريخ ${w.date} | ${w.reason}\n`; });
        report += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n`;
      });
      return message.reply(report);
    }
    if (cleanContent === 'مسح التحذيرات' || cleanContent === 'تصفير التحذيرات') {
      warnData = {};
      saveWarnings(warnData);
      return message.reply("تحت أمرك يا سيدي بروس، تم مسح وتطهير سجل التحذيرات بالكامل.");
    }
  }

  // ═══════════════════════════════════════════
  //   نظام الـ Reply المطور
  // ═══════════════════════════════════════════
  if (!message.author.bot && isPrivileged(message.author.id) && message.reference?.messageId) {
    try {
      const referencedMsg = await message.channel.messages.fetch(message.reference.messageId);
      const targetUser = referencedMsg.author;

      if (cleanContent.includes('تحذير')) {
        if (!targetUser.bot && !isProtected(message.guild, targetUser.id)) {
          await issueEscalatedWarning(message.channel, message.guild, targetUser, cleanContent || 'أمر مباشر من أصحاب القصر', 'أصحاب القصر');
          return;
        } else {
          await message.reply('🛡️ معذرة يا سيدي، لا يمكنني تحذير هذا الشخص.');
          return;
        }
      }
      if (cleanContent === 'سامحه' || cleanContent === 'فك العقاب' || cleanContent === 'عفو') {
        let memberToUnmute = await message.guild.members.fetch(targetUser.id).catch(() => null);
        if (targetUser.id === client.user.id) {
          const mentionMatch = referencedMsg.content.match(/<@!?(\d+)>/);
          if (mentionMatch) memberToUnmute = await message.guild.members.fetch(mentionMatch[1]).catch(() => null);
        }
        const resultText = await pardonMember(message.guild, memberToUnmute);
        await message.reply(resultText);
        return;
      }
    } catch (err) { console.error('Manual Action Error:', err); }
  }

  // ═══════════════════════════════════════════
  //   فحص السلوك التلقائي
  // ═══════════════════════════════════════════
  if (!message.author.bot && !isProtected(message.guild, message.author.id) && cleanContent.length > 0) {
    const isBad = await checkMessageSafety(cleanContent);
    if (isBad) {
      const lastWarnTime = autoWarnCooldown[message.author.id] || 0;
      if (Date.now() - lastWarnTime < AUTO_WARN_COOLDOWN_MS) return;
      autoWarnCooldown[message.author.id] = Date.now();
      await issueEscalatedWarning(message.channel, message.guild, message.author, 'استخدام عبارات غير لائقة في قنوات القصر', 'نظام قصر واين التلقائي');
      return;
    }
  }

  const isMentioned = message.mentions.has(client.user);
  cleanContent = cleanContent.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();

  // ═══════════════════════════════════════════
  //   أوامر بروس ومحمد الخاصة
  // ═══════════════════════════════════════════
  if (!message.author.bot && isPrivileged(message.author.id)) {
    if (cleanContent.startsWith('صلاحية')) {
      const targetMember = getMentionedMember(message);
      if (!targetMember) return message.reply('يرجى تحديد العضو بالمنشن يا سيدي.');
      try {
        await message.channel.permissionOverwrites.edit(targetMember.id, {
          ViewChannel: true, SendMessages: true, ManageChannels: true, AttachFiles: true, EmbedLinks: true
        });
        return message.channel.send(`✅ **أبشر يا سيدي.** منحتُ <@${targetMember.id}> كامل الصلاحيات لإدارة هذه القناة.`);
      } catch { return message.reply('معذرةً، لم أتمكن من تعديل الصلاحيات.'); }
    }

    if (cleanContent.startsWith('أعلن')) {
      const text = cleanContent.replace(/^أعلن/i, '').trim();
      if (!text) return message.reply('اكتب نص الإعلان.');
      await message.delete().catch(() => {});
      return message.channel.send(`📢 **إعلان رسمي من إدارة السيرفر:**\n\n${text}`);
    }

    if (cleanContent.startsWith('راسل')) {
      const target = getMentionedMember(message);
      if (!target) return message.reply('حدد العضو بالمنشن.');
      const text = cleanContent.replace(/^راسل/i, '').replace(/<@!?\d+>/, '').trim();
      if (!text) return message.reply('اكتب الرسالة بعد المنشن.');
      try {
        await target.send(`📩 رسالة من إدارة السيرفر:\n\n${text}`);
        await message.delete().catch(() => {});
        return message.channel.send(`✅ تم إرسال الرسالة لـ **${target.user.username}**.`);
      } catch { return message.reply('العضو مغلق الخاص.'); }
    }

    if (cleanContent === 'قفل') {
      const confirmed = await waitForConfirmation(message, `🔒 هل تريد قفل القناة؟ اكتب **تأكيد**.`);
      if (!confirmed) return;
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false }).catch(() => {});
      return message.channel.send('🔒 تم قفل القناة.');
    }
    if (cleanContent === 'فتح') {
      const confirmed = await waitForConfirmation(message, `🔓 هل تريد فتح القناة؟ اكتب **تأكيد**.`);
      if (!confirmed) return;
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: true }).catch(() => {});
      return message.channel.send('🔓 تم فتح القناة.');
    }

    if (cleanContent.startsWith('غير اسمي')) {
      const newName = cleanContent.replace(/^غير اسمي/i, '').trim();
      if (!newName) return message.reply('اكتب الاسم الجديد.');
      const confirmed = await waitForConfirmation(message, `✏️ تغيير اسمي إلى **${newName}**؟ اكتب **تأكيد**.`);
      if (!confirmed) return;
      await message.guild.members.me.setNickname(newName).catch(() => {});
      return message.reply(`✅ تم تغيير اسمي إلى **${newName}**.`);
    }

    if (cleanContent.startsWith('غير اسم')) {
      const target = getMentionedMember(message);
      if (!target) return message.reply('حدد العضو بالمنشن.');
      const newName = cleanContent.replace(/^غير اسم/i, '').replace(/<@!?\d+>/, '').trim();
      if (!newName) return message.reply('اكتب الاسم الجديد بعد المنشن.');
      const confirmed = await waitForConfirmation(message, `✏️ تغيير اسم **${target.user.username}** إلى **${newName}**؟ اكتب **تأكيد**.`);
      if (!confirmed) return;
      try { await target.setNickname(newName); return message.reply(`✅ تم التغيير.`); }
      catch { return message.reply('لم أتمكن من تغيير الاسم.'); }
    }

    if (cleanContent === 'اغلق') {
      const confirmed = await waitForConfirmation(message, '🎩 هل أنت متأكد من إغلاقي؟ اكتب **تأكيد**.');
      if (!confirmed) return;
      await message.channel.send('🎩 في أمان الله سيدي بروس. أغلق الآن...');
      process.exit(0);
    }

    if (cleanContent === 'إحصائيات') {
      const g = message.guild;
      const bots = g.members.cache.filter(m => m.user.bot).size;
      const humans = g.memberCount - bots;
      const totalWarnings = Object.keys(warnData).filter(id => !id.endsWith('_saved_roles')).reduce((a, id) => a + warnData[id].length, 0);
      return message.reply(`📊 الأعضاء: ${humans} بشر + ${bots} بوت\n📺 القنوات: ${g.channels.cache.size}\n⚠️ التحذيرات: ${totalWarnings}`);
    }
  }

  // ═══════════════════════════════════════════
  //   أوامر إدارية عامة للمشرفين
  // ═══════════════════════════════════════════
  if (!message.author.bot) {
    if (cleanContent.startsWith('ميوت')) {
      if (!hasModPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية التكتيم.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('الرجاء تحديد العضو بالمنشن.');
      if (isProtected(message.guild, target.id)) return message.reply('🛡️ لا يمكن تكتيم هذا الشخص.');
      const minutesMatch = cleanContent.match(/(\d+)\s*(دقيقة|دقائق|ساعة|ساعات|يوم|أيام)?/);
      let duration = 10 * 60 * 1000;
      if (minutesMatch) {
        const num = parseInt(minutesMatch[1]);
        if (cleanContent.includes('ساعة')) duration = num * 60 * 60 * 1000;
        else if (cleanContent.includes('يوم')) duration = num * 24 * 60 * 60 * 1000;
        else duration = num * 60 * 1000;
      }
      await message.reply(`ما سبب تكتيم **${target.user.username}**؟ (30 ثانية)`);
      const filter = m => m.author.id === message.author.id;
      let reason = 'لم يُذكر سبب';
      try {
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        reason = collected.first().content;
      } catch { return message.channel.send('انتهى الوقت.'); }
      try {
        await target.timeout(duration, `${reason} | ${message.author.tag}`);
        await sendLog(message.guild, `🔇 ميوت: <@${target.id}> | ${reason} | ${message.author.tag}`);
        return message.reply(`✅ تم تكتيم **${target.user.username}** لمدة ${Math.floor(duration / 60000)} دقيقة.\n📋 ${reason}`);
      } catch { return message.reply('فشل التكتيم.'); }
    }

    if (cleanContent.startsWith('فك ميوت')) {
      if (!hasModPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('حدد العضو بالمنشن.');
      try {
        await target.timeout(null);
        delete warnData[target.id + '_saved_roles'];
        saveWarnings(warnData);
        return message.reply(`✅ تم فك التكتيم.`);
      } catch { return message.reply('فشل فك التكتيم.'); }
    }

    if (cleanContent.startsWith('كيك') || cleanContent.startsWith('طرد')) {
      if (!hasKickPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية الطرد.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('حدد العضو بالمنشن.');
      if (isProtected(message.guild, target.id)) return message.reply('🛡️ لا يمكن طرده.');
      await message.reply(`ما سبب طرد **${target.user.username}**؟ (30 ثانية)`);
      const filter = m => m.author.id === message.author.id;
      let reason = 'لم يُذكر سبب';
      try {
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        reason = collected.first().content;
      } catch { return message.channel.send('انتهى الوقت.'); }
      try {
        await target.kick(`${reason} | ${message.author.tag}`);
        await sendLog(message.guild, `👢 طرد: <@${target.id}> | ${reason} | ${message.author.tag}`);
        return message.reply(`✅ تم الطرد.\n📋 ${reason}`);
      } catch { return message.reply('فشل الطرد.'); }
    }

    if (cleanContent.startsWith('باند') || cleanContent.startsWith('حظر')) {
      if (!hasBanPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية الحظر.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('حدد العضو بالمنشن.');
      if (isProtected(message.guild, target.id)) return message.reply('🛡️ لا يمكن حظره.');
      await message.reply(`ما سبب حظر **${target.user.username}**؟ (30 ثانية)`);
      const filter = m => m.author.id === message.author.id;
      let reason = 'لم يُذكر سبب';
      try {
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        reason = collected.first().content;
      } catch { return message.channel.send('انتهى الوقت.'); }
      try {
        await target.ban({ reason: `${reason} | ${message.author.tag}` });
        await sendLog(message.guild, `🔨 حظر: <@${target.id}> | ${reason} | ${message.author.tag}`);
        return message.reply(`✅ تم الحظر.\n📋 ${reason}`);
      } catch { return message.reply('فشل الحظر.'); }
    }

    if (cleanContent.startsWith('كلير')) {
      if (!isPrivileged(message.author.id) && !message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
      const numMatch = cleanContent.match(/\d+/);
      const amount = numMatch ? Math.min(parseInt(numMatch[0]), 100) : 10;
      try {
        await message.channel.bulkDelete(amount, true);
        const m = await message.channel.send(`🗑️ تم حذف ${amount} رسالة.`);
        setTimeout(() => m.delete().catch(() => {}), 3000);
      } catch { return message.reply('فشل الحذف.'); }
      return;
    }

    if (cleanContent.startsWith('تحذير') && getMentionedMember(message)) {
      if (!hasModPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية.');
      const target = getMentionedMember(message);
      if (isProtected(message.guild, target.id)) return message.reply('🛡️ لا يمكن تحذيره.');
      await message.reply(`ما سبب تحذير **${target.user.username}**؟ (30 ثانية)`);
      const filter = m => m.author.id === message.author.id;
      let reason = 'لم يُذكر سبب';
      try {
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        reason = collected.first().content;
      } catch { return message.channel.send('انتهى الوقت.'); }
      await issueEscalatedWarning(message.channel, message.guild, target.user, reason, message.author.tag);
      return;
    }

    if (cleanContent.startsWith('سجل')) {
      const target = getMentionedMember(message);
      if (!target) return message.reply('حدد العضو بالمنشن.');
      const list = warnData[target.id];
      if (!list || list.length === 0) return message.reply(`✅ لا توجد تحذيرات.`);
      const text = list.map((w, i) => `${i + 1}. ${w.reason} — ${w.by} (${w.date})`).join('\n');
      return message.reply(`📋 **تحذيرات ${target.user.username}:**\n${text}`);
    }

    if (cleanContent.startsWith('تقرير')) {
      if (!hasModPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('حدد العضو بالمنشن.');
      const list = warnData[target.id] || [];
      const isMuted = target.communicationDisabledUntilTimestamp && target.communicationDisabledUntilTimestamp > Date.now();
      const savedRoles = warnData[target.id + '_saved_roles'] || [];
      const last = list.length ? list[list.length - 1] : null;
      return message.reply(
        `📋 **تقرير ${target.user.username}:**\n🔢 ${list.length}/3\n🔇 مكتوم: ${isMuted ? 'نعم' : 'لا'}\n🎭 رتب محفوظة: ${savedRoles.length}\n📝 آخر مخالفة: ${last ? `${last.reason} (${last.date})` : 'لا يوجد'}`
      );
    }

    if (cleanContent.startsWith('عفو') && getMentionedMember(message)) {
      if (!isPrivileged(message.author.id) && !hasModPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية.');
      const target = getMentionedMember(message);
      const resultText = await pardonMember(message.guild, target);
      return message.reply(resultText);
    }

    if (cleanContent.startsWith('مسح تحذيرات')) {
      if (!hasModPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('حدد العضو بالمنشن.');
      warnData[target.id] = [];
      delete warnData[target.id + '_saved_roles'];
      saveWarnings(warnData);
      return message.reply(`🗑️ تم مسح التحذيرات.`);
    }
  }

  // ═══════════════════════════════════════════
  //   محادثة ألفريد الذكية (تشمل كاتوومان)
  // ═══════════════════════════════════════════
  let isReplyToAlfred = false;
  if (message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (refMsg.author.id === client.user.id) isReplyToAlfred = true;
    } catch {}
  }

  if (!isMentioned && !isReplyToAlfred) return;

  let userMessage = cleanContent;
  if (!userMessage) {
    const greeting = isPrivileged(message.author.id) ? 'تحت أمرك يا سيدي بروس، كيف يمكنني مساعدتك؟' : 'نعم، كيف يمكنني مساعدتك؟';
    return message.reply(greeting);
  }

  await message.channel.sendTyping();
  setTimeout(async () => {
    const reply = await getAlfredReply(message.channel.id, message.author.id, message.author.username, userMessage);
    message.reply(reply);
  }, 1200);
});

client.login(process.env.ALFRED_TOKEN);
