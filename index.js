const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Rota principal para o Railway validar que o serviço está online e mostrar status
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Atendimento WhatsApp - Online</title>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; background: #0f172a; color: #fff; text-align: center; padding-top: 50px; }
          .card { background: #1e293b; max-width: 600px; margin: 0 auto; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
          h1 { color: #38bdf8; }
          .status { color: #22c55e; font-weight: bold; font-size: 1.2em; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🤖 Robô de Atendimento WhatsApp</h1>
          <p class="status">● Sistema Online e Operacional na Nuvem</p>
          <p>O seu bot com Menu Estrito está pronto para receber conexões e gerenciar os atendimentos.</p>
        </div>
      </body>
    </html>
  `);
});

// Webhook para receber mensagens
app.post('/webhook', (req, res) => {
  console.log('[WEBHOOK RECEBIDO]', req.body);
  res.status(200).send({ status: 'received' });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
