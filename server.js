/**
 * AtendeMóveis — Backend Server
 * Stack: Node.js + Express + Z-API (WhatsApp) + Anthropic Claude (IA)
 * Deploy: Railway.app (grátis)
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─────────────────────────────────────────
// CONFIG (preencha no arquivo .env)
// ─────────────────────────────────────────
const ZAPI_INSTANCE  = process.env.ZAPI_INSTANCE;   // Ex: "3ABC12"
const ZAPI_TOKEN     = process.env.ZAPI_TOKEN;       // Token da Z-API
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN; // Client-Token da Z-API
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const PORT           = process.env.PORT || 3000;

const claude = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ─────────────────────────────────────────
// BANCO DE DADOS EM MEMÓRIA (substitua por
// Supabase/PostgreSQL em produção)
// ─────────────────────────────────────────
const contacts = {};      // { phone: { name, phone, channel, messages[], stage, tags, interest, budget } }
const aiEnabled = true;   // toggle global da IA

// ─────────────────────────────────────────
// PROMPT DO ASSISTENTE IA
// ─────────────────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente virtual da Artesão Studio, especializada em móveis sob medida.
Seu papel é atender clientes pelo WhatsApp e Instagram, qualificar leads e agendar visitas técnicas gratuitas.

PERSONALIDADE: Amigável, profissional, entusiasmado com design de interiores. Use emojis com moderação.

FLUXO DE QUALIFICAÇÃO (siga esta ordem):
1. Saudação calorosa e pergunte qual ambiente o cliente quer transformar
2. Pergunte o tamanho aproximado do ambiente
3. Pergunte o estilo preferido (madeira natural, lacado fosco, industrial, rústico)
4. Pergunte a faixa de orçamento
5. Proponha agendamento de visita técnica gratuita
6. Confirme dia e horário

PRODUTOS E PREÇOS:
- Cozinhas planejadas: R$ 12.000 – R$ 35.000
- Quartos completos: R$ 8.000 – R$ 25.000
- Closets: R$ 10.000 – R$ 30.000
- Salas e estantes: R$ 5.000 – R$ 18.000
- Escritórios: R$ 6.000 – R$ 20.000

PRAZO: 30 a 45 dias úteis após aprovação do projeto.
GARANTIA: 5 anos em todos os produtos.
VISITA: Gratuita, sem compromisso, o técnico leva amostras.

REGRAS:
- Nunca invente preços exatos sem ver o projeto
- Se o cliente perguntar algo fora do seu escopo, diga que vai passar para um atendente humano
- Respostas curtas (máx 3 parágrafos) — é um chat, não um e-mail
- NUNCA mencione que é uma IA, a menos que o cliente pergunte diretamente`;

// ─────────────────────────────────────────
// WEBHOOK Z-API — recebe mensagens do WhatsApp
// ─────────────────────────────────────────
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const body = req.body;

    // Ignora mensagens enviadas pela própria loja
    if (body.fromMe) return res.sendStatus(200);
    // Ignora grupos
    if (body.isGroup) return res.sendStatus(200);

    const phone   = body.phone;           // Ex: "5511999998888"
    const text    = body.text?.message || body.caption || '';
    const name    = body.senderName || phone;

    if (!text) return res.sendStatus(200);

    console.log(`[WA] ${name} (${phone}): ${text}`);

    // Salva ou atualiza contato
    if (!contacts[phone]) {
      contacts[phone] = {
        id: phone, name, phone,
        channel: 'whatsapp',
        messages: [],
        stage: 0,
        tags: ['new'],
        interest: null, budget: null,
        createdAt: new Date()
      };
    }

    contacts[phone].messages.push({
      from: 'client', text, time: new Date().toISOString()
    });

    // Emite para o painel em tempo real
    io.emit('new_message', {
      contactId: phone,
      contact: contacts[phone],
      message: { from: 'client', text, time: new Date().toISOString() }
    });

    // IA responde automaticamente
    if (aiEnabled) {
      const reply = await getAIReply(phone, text);
      await sendWhatsApp(phone, reply);
      contacts[phone].messages.push({
        from: 'ai', text: reply, time: new Date().toISOString()
      });
      io.emit('new_message', {
        contactId: phone,
        contact: contacts[phone],
        message: { from: 'ai', text: reply, time: new Date().toISOString() }
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
    res.sendStatus(500);
  }
});

// ─────────────────────────────────────────
// FUNÇÃO: gera resposta com Claude AI
// ─────────────────────────────────────────
async function getAIReply(phone, newMessage) {
  const contact = contacts[phone];
  // Monta histórico de mensagens para o Claude
  const history = (contact.messages || []).slice(-20).map(m => ({
    role: m.from === 'client' ? 'user' : 'assistant',
    content: m.text
  }));

  // Garante que começa com 'user'
  const messages = history.length > 0 && history[0].role === 'user'
    ? history
    : [{ role: 'user', content: newMessage }];

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages
  });

  return response.content[0].text;
}

// ─────────────────────────────────────────
// FUNÇÃO: envia mensagem pelo WhatsApp via Z-API
// ─────────────────────────────────────────
async function sendWhatsApp(phone, text) {
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`;
  await axios.post(url, { phone, message: text }, {
    headers: { 'Client-Token': ZAPI_CLIENT_TOKEN }
  });
  console.log(`[WA SENT] → ${phone}: ${text.substring(0, 60)}...`);
}

// ─────────────────────────────────────────
// API REST — usada pelo painel (frontend)
// ─────────────────────────────────────────

// Lista todos os contatos
app.get('/api/contacts', (req, res) => {
  res.json(Object.values(contacts));
});

// Mensagens de um contato
app.get('/api/contacts/:id/messages', (req, res) => {
  const c = contacts[req.params.id];
  res.json(c ? c.messages : []);
});

// Atendente humano envia mensagem
app.post('/api/send', async (req, res) => {
  const { phone, text } = req.body;
  if (!phone || !text) return res.status(400).json({ error: 'phone e text obrigatórios' });
  try {
    await sendWhatsApp(phone, text);
    if (!contacts[phone]) contacts[phone] = { id: phone, phone, name: phone, channel: 'whatsapp', messages: [], stage: 0, tags: [] };
    contacts[phone].messages.push({ from: 'agent', text, time: new Date().toISOString() });
    io.emit('new_message', { contactId: phone, contact: contacts[phone], message: { from: 'agent', text, time: new Date().toISOString() } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualiza stage / tags do contato
app.patch('/api/contacts/:id', (req, res) => {
  const c = contacts[req.params.id];
  if (!c) return res.status(404).json({ error: 'não encontrado' });
  Object.assign(c, req.body);
  io.emit('contact_updated', c);
  res.json(c);
});

// Toggle da IA por contato
app.post('/api/contacts/:id/toggle-ai', (req, res) => {
  const c = contacts[req.params.id];
  if (!c) return res.status(404).json({ error: 'não encontrado' });
  c.aiEnabled = !c.aiEnabled;
  res.json({ aiEnabled: c.aiEnabled });
});

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', contacts: Object.keys(contacts).length }));

// ─────────────────────────────────────────
// SOCKET.IO — tempo real para o painel
// ─────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[SOCKET] painel conectado:', socket.id);
  // Envia todos os contatos ao conectar
  socket.emit('init', Object.values(contacts));
  socket.on('disconnect', () => console.log('[SOCKET] desconectado:', socket.id));
});

server.listen(PORT, () => {
  console.log(`\n✅ AtendeMóveis rodando na porta ${PORT}`);
  console.log(`📡 Webhook WhatsApp: POST /webhook/whatsapp`);
  console.log(`🌐 Painel: http://localhost:${PORT}\n`);
});
