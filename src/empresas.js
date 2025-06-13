const puppeteer = require('puppeteer');
const { Pool } = require('pg');
const readline = require('readline');
const fs = require('fs');

// CONFIGURAÇÕES
const dbConfig = {
  user: 'postgres',
  host: 'localhost',
  database: 'ifood',
  password: 'root',
  port: 5432,
};

const USER_DATA_DIR = './profile_ifood'; // Diretório persistente para manter sessão

// Conexão com PostgreSQL
const pool = new Pool(dbConfig);

// Função para esperar ENTER no terminal
function esperarEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('Faça o login no iFood e aperte ENTER para continuar...', () => {
      rl.close();
      resolve();
    });
  });
}

// Carrega nomes já salvos do banco (evita duplicados já persistidos)
async function carregarNomesExistentes() {
  const result = await pool.query('SELECT nome FROM empresas');
  return new Set(result.rows.map(row => row.nome.toLowerCase().trim()));
}

// Salvar empresas no banco
async function salvarEmpresas(empresaArray, empresasSalvas) {
  for (const empresa of empresaArray) {
    const nomeNormalizado = empresa.nome.toLowerCase().trim();
    if (empresasSalvas.has(nomeNormalizado)) {
      console.log(`Ignorada (duplicada): ${empresa.nome}`);
      continue;
    }

    try {
      await pool.query(
        'INSERT INTO empresas (nome, link_empresa) VALUES ($1, $2)',
        [empresa.nome, empresa.link]
      );
      console.log(`Salvo: ${empresa.nome}`);
      empresasSalvas.add(nomeNormalizado);
    } catch (err) {
      console.error(`Erro ao salvar ${empresa.nome}:`, err.message);
    }
  }
}

// Função para processar uma URL individual
async function processarUrl(page, url, empresasSalvas) {
  console.log(`Acessando: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2' });

  try {
    while (await page.$('.cardstack-nextcontent__button') !== null) {
      console.log('Carregando mais empresas...');
      await page.click('.cardstack-nextcontent__button');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } catch (err) {
    console.error('Erro ao clicar em botão de carregar mais:', err.message);
  }

  const empresas = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('a.merchant-v2__link'));
    return cards.map(card => {
      const nome = card.querySelector('.merchant-v2__name')?.innerText.trim() || 'Nome não encontrado';
      const link = 'https://www.ifood.com.br' + card.getAttribute('href');
      return { nome, link };
    });
  });

  console.log(`Encontradas ${empresas.length} empresas em ${url}`);
  await salvarEmpresas(empresas, empresasSalvas);
}

// Função principal
(async () => {
  const urls = JSON.parse(fs.readFileSync('links.json', 'utf-8'));
  const empresasSalvas = await carregarNomesExistentes();

  // Etapa 1: Login manual
  const browserLogin = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: USER_DATA_DIR,
  });

  const pageLogin = await browserLogin.newPage();
  console.log('Acessando ifood.com.br...');
  await pageLogin.goto('https://www.ifood.com.br', { waitUntil: 'networkidle2' });
  await esperarEnter(); // Aguarda login manual
  await browserLogin.close(); // Fecha o navegador com interface

  // Etapa 2: Navegador headless usando mesma sessão
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: USER_DATA_DIR,
  });

  const page = await browser.newPage();

  for (const url of urls) {
    try {
      await processarUrl(page, url, empresasSalvas);
    } catch (err) {
      console.error(`Erro ao processar ${url}:`, err.message);
    }
  }

  await browser.close();
  await pool.end();
})();
