const puppeteer = require('puppeteer');
const { Client } = require('pg');

const dbConfig = {
  user: 'postgres',
  host: 'localhost',
  database: 'ifood',
  password: 'root',
  port: 5432,
};

const diasMap = {
  'Segunda-feira': 'seg',
  'Terça-feira': 'ter',
  'Quarta-feira': 'qua',
  'Quinta-feira': 'qui',
  'Sexta-feira': 'sex',
  'Sábado': 'sab',
  'Domingo': 'dom',
};

const TIMEOUT_MS = 5000; // tempo máximo para tentar extrair um link

async function withTimeout(promise, ms) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Timeout')), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

(async () => {
  const client = new Client(dbConfig);
  await client.connect();

  try {
    // Buscar só as empresas sem horários preenchidos
    const res = await client.query(`
      SELECT id, link_empresa FROM empresas
      WHERE seg IS NULL AND ter IS NULL AND qua IS NULL AND qui IS NULL AND sex IS NULL AND sab IS NULL AND dom IS NULL
      AND link_empresa IS NOT NULL
    `);

    if (res.rowCount === 0) {
      console.log('Nenhuma empresa pendente para atualização.');
      return;
    }

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    const filaRetry = [];

    async function processarEmpresa(id, link) {
      console.log(`Processando empresa ID ${id}...`);

      await page.goto(link, { waitUntil: 'networkidle0' });

      await page.waitForSelector('.merchant-details__button', { visible: true });
      await page.click('.merchant-details__button');

      await page.waitForSelector('#marmita-tab1-1', { visible: true });
      await page.evaluate(() => {
        const btn = document.querySelector('#marmita-tab1-1');
        if (btn) btn.click();
      });

      await page.waitForSelector('.merchant-details-schedule', { visible: true });

      const horarios = await page.$$eval('.merchant-details-schedule__day', dias => {
        return dias.map(dia => {
          const nome = dia.querySelector('.merchant-details-schedule__day-title-text')?.innerText.trim();
          const horario = dia.querySelector('.merchant-details-schedule__day-schedule')?.innerText.trim();
          return { nome, horario };
        });
      });

      const dados = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null };
      horarios.forEach(({ nome, horario }) => {
        const coluna = diasMap[nome];
        if (coluna) dados[coluna] = horario;
      });

      const query = `
        UPDATE empresas SET seg=$1, ter=$2, qua=$3, qui=$4, sex=$5, sab=$6, dom=$7 WHERE id=$8
      `;
      const valores = [
        dados.seg, dados.ter, dados.qua, dados.qui, dados.sex, dados.sab, dados.dom, id
      ];

      await client.query(query, valores);
      console.log(`Empresa ID ${id} atualizada com sucesso.`);
    }

    for (const { id, link_empresa } of res.rows) {
      try {
        // Usa withTimeout para garantir que a função não passe do limite de tempo
        await withTimeout(processarEmpresa(id, link_empresa), TIMEOUT_MS);
      } catch (error) {
        console.warn(`Erro / timeout na empresa ID ${id}, guardando para retry: ${error.message}`);
        filaRetry.push({ id, link_empresa });
      }
    }

    // Tentar os que falharam 1 vez mais tarde (sem timeout, ou com timeout maior)
    if (filaRetry.length > 0) {
      console.log(`Tentando novamente ${filaRetry.length} empresas que falharam...`);
      for (const { id, link_empresa } of filaRetry) {
        try {
          await withTimeout(processarEmpresa(id, link_empresa), TIMEOUT_MS * 2);
        } catch (error) {
          console.error(`Falha no retry para empresa ID ${id}: ${error.message}`);
        }
      }
    }

    await browser.close();

  } catch (error) {
    console.error('Erro geral:', error);
  } finally {
    await client.end();
  }
})();
