const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const { Pool } = require('pg');

const dbConfig = {
  user: 'postgres',
  host: 'localhost',
  database: 'ifood',
  password: 'root',
  port: 5432,
};

const pool = new Pool(dbConfig);

function limparCNPJ(texto) {
  return texto.replace(/\D/g, '');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  try {
    const res = await pool.query('SELECT id, link_empresa FROM empresas WHERE cnpj IS NULL');
    const empresas = res.rows;

    console.log(`🔗 Encontradas ${empresas.length} empresas para processar.`);

    for (const empresa of empresas) {
      const { id, link_empresa } = empresa;

      try {
        console.log(`\n🌐 Acessando: ${link_empresa}`);
        await page.goto(link_empresa, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(3000);

        const botaoModal = await page.$('.merchant-details__button');
        if (!botaoModal) {
          console.warn(`⚠️ Botão do modal não encontrado para ID ${id}`);
          continue;
        }

        await botaoModal.click();
        await delay(2000); // espera o modal abrir

        // Novo seletor conforme sua indicação
        const seletorCNPJ = '.merchant-details-about__info + .merchant-details-about__info .merchant-details-about__info-data';
        await page.waitForSelector(seletorCNPJ, { timeout: 10000 });

        const textosInfo = await page.$$eval(seletorCNPJ, els =>
          els.map(el => el.innerText)
        );

        console.log(`🧾 Textos extraídos:`, textosInfo);

        const cnpjBruto = textosInfo.find(texto => texto.includes('CNPJ'));

        if (cnpjBruto) {
          const match = cnpjBruto.match(/(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/);
          if (match) {
            const cnpjLimpo = limparCNPJ(match[1]);
            console.log(`✅ CNPJ encontrado: ${cnpjLimpo}`);
            await pool.query('UPDATE empresas SET cnpj = $1 WHERE id = $2', [cnpjLimpo, id]);
          } else {
            console.warn(`⚠️ CNPJ com formato inesperado para ID ${id}`);
          }
        } else {
          console.warn(`⚠️ Nenhum texto com CNPJ encontrado para ID ${id}`);
        }

      } catch (erro) {
        console.error(`❌ Erro ao processar ${link_empresa}:`, erro.message);
      }
    }

    console.log('\n🏁 Processo finalizado.');
  } catch (err) {
    console.error('❌ Erro ao conectar ou buscar no banco:', err.message);
  } finally {
    await browser.close();
    await pool.end();
  }
})();
