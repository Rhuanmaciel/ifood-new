const axios = require('axios');
const { Client } = require('pg');

const dbConfig = {
  user: 'postgres',
  host: 'localhost',
  database: 'ifood',
  password: 'root',
  port: 5432,
};

const MAX_SOCIOS = 10;

function limparRazaoSocial(razao) {
  return razao.replace(/[0-9]/g, '').trim();
}

async function garantirColunasDonos(client) {
  for (let i = 1; i <= MAX_SOCIOS; i++) {
    const columnName = `dono${i}`;
    const sql = `ALTER TABLE empresas ADD COLUMN IF NOT EXISTS ${columnName} VARCHAR(255)`;
    await client.query(sql);
  }
}

async function buscarCNPJsParaConsultar(client) {
  const condicoes = [];
  for (let i = 1; i <= MAX_SOCIOS; i++) {
    condicoes.push(`dono${i} IS NULL`);
  }
  const whereClause = condicoes.join(' AND ');

  const sql = `SELECT cnpj FROM empresas WHERE cnpj IS NOT NULL AND (${whereClause})`;
  const res = await client.query(sql);
  return res.rows.map(row => row.cnpj);
}

async function atualizarDonosNoBanco(client, cnpj, nomes) {
  const sets = nomes
    .slice(0, MAX_SOCIOS)
    .map((nome, i) => `dono${i + 1} = $${i + 2}`)
    .join(', ');

  const valores = [cnpj, ...nomes.slice(0, MAX_SOCIOS)];

  const sql = `UPDATE empresas SET ${sets} WHERE cnpj = $1`;

  await client.query(sql, valores);
}

async function consultarCNPJ(cnpj, tentativas = 3, delay = 3000) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const response = await axios.get(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
      const data = response.data;

      let nomes = [];

      if (data.qsa && Array.isArray(data.qsa) && data.qsa.length > 0) {
        nomes = data.qsa.map(socio => socio.nome_socio);
      } else if (data.razao_social) {
        nomes = [limparRazaoSocial(data.razao_social)];
      }

      return nomes;
    } catch (err) {
      if (err.response?.status === 429) {
        console.error(`🚨 429: Muitas requisições para o CNPJ ${cnpj}. Aguardando antes de tentar novamente.`);
      } else if (err.response?.status === 524) {
        console.error(`⏳ Timeout (524) ao consultar CNPJ ${cnpj}. Tentando novamente (${i + 1}/${tentativas})...`);
      } else {
        console.error(`❌ Erro ao consultar CNPJ ${cnpj}:`, err.response?.data?.message || err.message);
        break; // Erro diferente, não vale a pena repetir
      }

      if (i < tentativas - 1) {
        await new Promise(res => setTimeout(res, delay));
      }
    }
  }

  return null;
}

async function main() {
  const client = new Client(dbConfig);
  await client.connect();

  await garantirColunasDonos(client);

  const cnpjs = await buscarCNPJsParaConsultar(client);

  for (const cnpj of cnpjs) {
    console.log(`\n🔍 Processando CNPJ: ${cnpj}`);
    const nomes = await consultarCNPJ(cnpj);
    if (nomes && nomes.length > 0) {
      console.log('👥 Sócios/Razão Social:', nomes);
      await atualizarDonosNoBanco(client, cnpj, nomes);
      console.log('✅ Atualizado no banco.');
    } else {
      console.log('⚠️ Nenhum nome encontrado para salvar.');
    }
  }

  await client.end();
}

main();
