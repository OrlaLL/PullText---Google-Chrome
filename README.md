# PullText — extensão para Google Chrome

Captura uma página da web por completo e entrega tudo num único arquivo `.zip`,
nomeado com o domínio da página (ex.: `www.exemplo.com.br.zip`). O download começa
automaticamente assim que o ZIP fica pronto.

## O que vem dentro do ZIP

| Arquivo | Conteúdo |
| --- | --- |
| `desktop-1920px.png` | Print da página inteira na versão **desktop**: 1920px de largura, altura total da página |
| `mobile-480px.png` | Print da página inteira na versão **mobile**: 480px de largura, altura total da página |
| `conteudo.md` | Todo o texto visível da página em **Markdown**, na ordem de leitura (linhas de cima para baixo e, em cada linha, colunas da esquerda para a direita) |
| `meta-tags.json` | Todas as **meta tags** (description, keywords, robots, viewport, Open Graph, Twitter Cards etc.), links relevantes (canonical, ícones, alternate) e dados estruturados JSON-LD |
| `info.txt` | **Domínio**, URL, título, **data**, **hora** e fuso horário da captura |

## Instalação (modo desenvolvedor)

1. Abra o Chrome e acesse `chrome://extensions`.
2. Ative **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione esta pasta (`PullText`, a que contém o `manifest.json`).
4. (Opcional) Clique no ícone de quebra-cabeça da barra do Chrome e fixe o **PullText** para deixá-lo sempre visível.

## Como usar

1. Abra a página que deseja capturar e espere ela carregar.
2. Clique no ícone do **PullText** e depois em **Capturar e baixar ZIP**
   — ou use o atalho **Alt + Shift + P**.
3. Acompanhe o progresso no popup ou no número exibido sobre o ícone.
4. Ao terminar, o arquivo `<domínio>.zip` é baixado para a sua pasta de downloads e o ícone mostra **OK**.

Uma captura leva normalmente de 10 a 40 segundos, conforme o tamanho da página.

### Durante a captura

- O Chrome mostra a faixa **"PullText começou a depurar este navegador"**. Isso é normal: a extensão usa o
  protocolo de depuração do Chrome para renderizar a página exatamente em 1920px e 480px de largura,
  independentemente do tamanho da sua janela. A faixa some sozinha no final. **Não clique em "Cancelar"**,
  ou a captura será interrompida.
- A página vai piscar, mudar de tamanho e rolar sozinha: a extensão percorre a página para carregar
  imagens com carregamento tardio (lazy-load) e depois fotografa trecho por trecho.
- **Mantenha a aba visível** até o fim (não troque de aba nem minimize a janela).
- Ao final, a página volta ao tamanho e à posição de rolagem originais.

## Detalhes técnicos

- **Capturas:** a largura é emulada com 1920px (desktop) e 480px (mobile, com toque e user-agent de celular),
  escala 1:1 e barras de rolagem ocultas. Cabeçalhos e elementos fixos (menus, botões de chat, banners)
  aparecem uma única vez, no topo, em vez de se repetirem ao longo da imagem.
- **Páginas muito longas:** cada PNG tem no máximo 25.000px de altura. Acima disso a imagem é dividida
  em partes (`desktop-1920px-parte-1.png`, `-parte-2.png` …), e o `info.txt` registra o aviso.
  Páginas de rolagem infinita são limitadas a 150.000px.
- **Markdown:** títulos, parágrafos, negrito/itálico, links, imagens (com texto alternativo), listas
  (inclusive aninhadas), tabelas, citações e blocos de código. Elementos ocultos, scripts e textos
  "somente para leitor de tela" são ignorados. Em layouts com colunas (flexbox/grid) a ordem segue a
  posição visual na tela, e não a ordem do código HTML.
- **Sem dependências externas:** o ZIP é gerado pela própria extensão (`lib/zip.js`); nada é enviado
  para nenhum servidor.

## Limitações

- Páginas internas do Chrome (`chrome://…`), a Chrome Web Store e o visualizador de PDF não podem ser capturados.
- Se o **DevTools (F12)** estiver aberto na aba, feche-o antes de capturar.
- Para capturar arquivos locais (`file://`), ative **Permitir acesso aos URLs de arquivo** nos detalhes
  da extensão em `chrome://extensions`.
- Sites que identificam o celular apenas pelo servidor (sem layout responsivo) podem mostrar no print
  mobile a versão desktop reduzida, já que a página não é recarregada.
- Sites que rolam dentro de uma área interna (e não na página) podem ter apenas a parte visível capturada;
  nesse caso o `info.txt` traz um aviso.
- Se o Chrome estiver configurado para **perguntar onde salvar cada arquivo**, a janela de "Salvar como"
  aparecerá antes do download.

## Estrutura do projeto

```
PullText/
├── manifest.json          Configuração da extensão (Manifest V3)
├── background.js          Orquestra a captura, gera o ZIP e inicia o download
├── content/extractor.js   Extrai o Markdown e as meta tags da página
├── lib/zip.js             Gerador de ZIP sem dependências
├── popup/                 Interface do botão da extensão
└── icons/                 Ícones 16, 32, 48 e 128px
```

## Permissões usadas

| Permissão | Para quê |
| --- | --- |
| `activeTab` | Acessar somente a aba em que você clicou no PullText |
| `scripting` | Ler o texto e as meta tags da página |
| `debugger` | Renderizar a página em 1920px/480px e tirar os prints |
| `downloads` | Salvar o arquivo ZIP |

## Atualizando a extensão

Depois de alterar qualquer arquivo, volte a `chrome://extensions` e clique no ícone de recarregar (↻) no card do PullText.
