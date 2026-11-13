/** The texts of the home pages, in English and Japanese, with the same parts in the same order. */

export type Language = "en" | "ja";

export type IconName =
  | "vscode"
  | "react"
  | "browser"
  | "terminal"
  | "chat"
  | "notebook"
  | "rows"
  | "canvas"
  | "sheet"
  | "shield"
  | "braces"
  | "engine"
  | "arrow"
  | "copy"
  | "check";

interface Link {
  text: string;
  href: string;
}

interface App {
  icon: IconName;
  title: string;
  text: string;
  /** A command to run, shown as code. */
  code?: string;
  link: Link;
}

interface Texts {
  news: Link & { tag: string };
  title: [plain: string, accent: string];
  lead: string;
  actions: { start: Link; demo: Link; open: Link };
  install: { command: string; copy: string; copied: string };
  window: { title: string; live: string; caption: string };
  statsLabel: string;
  stats: { value: string; label: string }[];
  builtOn: { label: string; items: string[] };
  apps: {
    heading: string;
    text: string;
    vscode: App & { image: string; stores: Link[] };
    others: App[];
  };
  features: { heading: string; text: string; items: { icon: IconName; title: string; text: string }[] };
  code: {
    heading: string;
    text: string;
    links: Link[];
    tabs: { memory: string; server: string };
  };
  end: {
    heading: string;
    text: string;
    demo: Link;
    open: Link;
    github: Link;
    note: [string, Link, string, Link, string];
  };
}

const marketplace = "https://marketplace.visualstudio.com/items?itemName=yhay81.vastgrid-vscode";
const openVsx = "https://open-vsx.org/extension/yhay81/vastgrid-vscode";
const github = "https://github.com/yhay81/vastgrid";
const changelog = `${github}/blob/main/CHANGELOG.md`;

export const texts: Record<Language, Texts> = {
  en: {
    news: { tag: "New", text: "vastgrid for VS Code is on the Marketplace and Open VSX", href: "/apps/vscode/" },
    title: ["Open huge tables", "like a spreadsheet"],
    lead:
      "vastgrid is a canvas data grid for CSV, TSV, Parquet, JSON Lines and Excel files and DuckDB databases of any " +
      "size. Scroll a hundred million rows, sort, filter and group the whole file, and save your edits with every " +
      "other byte kept as it was.",
    actions: {
      start: { text: "Get started", href: "/getting-started/" },
      demo: { text: "Try the demo", href: "/demo/" },
      open: { text: "Open a file", href: "/open/" },
    },
    install: { command: "npm install vastgrid vastgrid-js", copy: "Copy the command", copied: "Copied" },
    window: {
      title: "orders · 100,000 rows",
      live: "Live, in a Web Worker",
      caption:
        "100,000 made-up orders, made by the memory engine in a Web Worker of this page. Open a column's menu (▾) " +
        "to sort, filter or group, drag across cells to see their sum below, and press ⌘F or Ctrl+F to find.",
    },
    statsLabel: "vastgrid in numbers",
    stats: [
      { value: "100M rows", label: "in one Parquet file of 1.38 GB, read in place" },
      { value: "< 1 s", label: "to the first rows of its sort, on DuckDB" },
      { value: "60 fps", label: "while scrolling: no React render, no dropped frame" },
      { value: "9 languages", label: "and an ARIA grid that works with the keyboard alone" },
    ],
    builtOn: {
      label: "Built on",
      items: ["DuckDB", "Apache Arrow", "Parquet", "React", "Web Workers", "MCP Apps", "anywidget"],
    },
    apps: {
      heading: "One grid, wherever your data is",
      text:
        "Put it in a React app, or open files with it right away: in VS Code, a terminal, the browser, an AI " +
        "chat or a notebook.",
      vscode: {
        icon: "vscode",
        title: "VS Code",
        text:
          "CSV, Parquet, Excel, JSON Lines and DuckDB files open in the editor. Edit the cells of CSV and TSV files, " +
          "and save them with VS Code's own Save.",
        code: "code --install-extension yhay81.vastgrid-vscode",
        link: { text: "The extension", href: "/apps/vscode/" },
        image:
          "A Parquet file of 100,000,000 rows in VS Code, sorted by price, with every price selected and their " +
          "count, sum and average in the status bar",
        stores: [
          { text: "Marketplace", href: marketplace },
          { text: "Open VSX", href: openVsx },
        ],
      },
      others: [
        {
          icon: "react",
          title: "React",
          text: "A component and its engines: in memory, in a Web Worker, on a server, or your own.",
          code: "npm install vastgrid vastgrid-js",
          link: { text: "Getting started", href: "/getting-started/" },
        },
        {
          icon: "browser",
          title: "The browser",
          text: "Drop a file on the page: a Web Worker reads it, and nothing is uploaded.",
          link: { text: "Open a file", href: "/open/" },
        },
        {
          icon: "terminal",
          title: "The command line",
          text: "One command opens a file in your browser, read by DuckDB on your computer.",
          code: "npx vastgrid-cli sales.parquet",
          link: { text: "The command", href: "/apps/cli/" },
        },
        {
          icon: "chat",
          title: "An AI chat",
          text:
            "An MCP App for Claude Desktop, ChatGPT, VS Code and Goose: the agent opens the grid in the " +
            "conversation, and you both work on it.",
          code: "npx -y vastgrid-mcp ./data",
          link: { text: "The MCP server", href: "/apps/mcp/" },
        },
        {
          icon: "notebook",
          title: "Jupyter",
          text:
            "Show a pandas or Polars DataFrame, a DuckDB relation or a file in a notebook, and get the edited " +
            "table back.",
          code: "pip install vastgrid",
          link: { text: "The widget", href: "/apps/notebook/" },
        },
      ],
    },
    features: {
      heading: "What a spreadsheet does, for every row",
      text:
        "Sorting, filtering, grouping and statistics run in the engine, over the whole table, not over the rows " +
        "on screen.",
      items: [
        {
          icon: "rows",
          title: "Any size",
          text:
            "Rows are read a block at a time as you scroll. Parquet files are read in place, also over HTTP " +
            "Range requests.",
        },
        {
          icon: "canvas",
          title: "Drawn on a canvas",
          text:
            "Scrolling renders no React and drops no frame, and an arrow key commits React once. Under the " +
            "canvas, it is an ARIA grid.",
        },
        {
          icon: "sheet",
          title: "A spreadsheet's way of working",
          text:
            "Excel's keys and selections, filters and conditions, search and find, groups, pivots and totals, " +
            "formulas, formats, copy, cut, paste and fill.",
        },
        {
          icon: "shield",
          title: "Edits you can trust",
          text:
            "Input is checked against each column's type, conflicts are caught, and every write can be undone. " +
            "Saving a CSV or TSV file rewrites only the edited fields.",
        },
        {
          icon: "braces",
          title: "Commands are the API",
          text:
            "The view is a JSON document. Every change is a typed command, which your toolbar, a host or an AI " +
            "agent dispatches as the grid's menus do.",
        },
        {
          icon: "engine",
          title: "Engines you choose",
          text:
            "vastgrid-js in the page or a Web Worker, vastgrid-duckdb on Node.js, or your own: one " +
            "specification, and a conformance corpus that both engines pass.",
        },
      ],
    },
    code: {
      heading: "A grid in a few lines",
      text:
        "Install the grid and an engine, and give it a table. The same component reads the files of a server " +
        "through vastgrid-duckdb, or the files a person picks in a Web Worker.",
      links: [
        { text: "Getting started", href: "/getting-started/" },
        { text: "Large files in the browser", href: "/guides/browser/" },
        { text: "Files on a server", href: "/guides/server/" },
        { text: "Your own engine", href: "/guides/custom-engine/" },
      ],
      tabs: { memory: "In memory", server: "On a server" },
    },
    end: {
      heading: "Open your largest file",
      text: "Try the demo's 200,000 orders, or open a file of yours: it stays in your browser.",
      demo: { text: "Try the demo", href: "/demo/" },
      open: { text: "Open a file", href: "/open/" },
      github: { text: "GitHub", href: github },
      note: [
        "Coming from vastgrid 0.1? See ",
        { text: "Migrating from 0.1", href: "/migrating-from-0-1/" },
        ". Every release is in the ",
        { text: "changelog", href: changelog },
        ".",
      ],
    },
  },
  ja: {
    news: {
      tag: "新着",
      text: "VS Code の拡張機能を Marketplace と Open VSX で公開しました",
      href: "/ja/apps/vscode/",
    },
    title: ["巨大な表を、", "表計算ソフトのように。"],
    lead:
      "vastgrid は、どんな大きさの CSV・TSV・Parquet・JSON Lines・Excel のファイルや DuckDB のデータベースも" +
      "開ける、キャンバスに描くデータグリッドです。1 億行をスクロールし、ファイル全体を並べ替え・絞り込み・" +
      "グループ化して、編集はほかのバイトをそのまま残して保存します。",
    actions: {
      start: { text: "はじめる", href: "/ja/getting-started/" },
      demo: { text: "デモを試す", href: "/ja/demo/" },
      open: { text: "ファイルを開く", href: "/ja/open/" },
    },
    install: { command: "npm install vastgrid vastgrid-js", copy: "コマンドをコピー", copied: "コピーしました" },
    window: {
      title: "orders · 10 万行",
      live: "ライブ・Web Worker の中",
      caption:
        "架空の注文 10 万件を、このページの Web Worker の中でメモリエンジンが作っています。列のメニュー（▾）で" +
        "並べ替え・絞り込み・グループ化、セルの上をドラッグすると下に合計が出て、⌘F か Ctrl+F で検索できます。",
    },
    statsLabel: "数字で見る vastgrid",
    stats: [
      { value: "1 億行", label: "1.38 GB の Parquet ファイルも、その場で読みます" },
      { value: "1 秒未満", label: "で、その並べ替えの先頭の行が出ます（DuckDB）" },
      { value: "60 fps", label: "スクロール中も React は描画せず、フレームを落としません" },
      { value: "9 言語", label: "ARIA のグリッドで、キーボードだけでも操作できます" },
    ],
    builtOn: {
      label: "使っている技術",
      items: ["DuckDB", "Apache Arrow", "Parquet", "React", "Web Workers", "MCP Apps", "anywidget"],
    },
    apps: {
      heading: "データのある場所で、同じグリッドを",
      text:
        "React のアプリに組み込むことも、すぐにファイルを開くこともできます。VS Code、ターミナル、ブラウザー、" +
        "AI のチャット、ノートブックで。",
      vscode: {
        icon: "vscode",
        title: "VS Code",
        text:
          "CSV・Parquet・Excel・JSON Lines・DuckDB のファイルをエディターで開きます。CSV と TSV はセルを編集して、" +
          "VS Code の保存で保存できます。",
        code: "code --install-extension yhay81.vastgrid-vscode",
        link: { text: "拡張機能", href: "/ja/apps/vscode/" },
        image:
          "VS Code で開いた 1 億行の Parquet ファイル。価格で並べ替え、価格の列をすべて選んで、ステータスバーに" +
          "個数・合計・平均が出ている",
        stores: [
          { text: "Marketplace", href: marketplace },
          { text: "Open VSX", href: openVsx },
        ],
      },
      others: [
        {
          icon: "react",
          title: "React",
          text: "コンポーネントとエンジン。メモリ、Web Worker、サーバー、自作のエンジンから選べます。",
          code: "npm install vastgrid vastgrid-js",
          link: { text: "使い始める", href: "/ja/getting-started/" },
        },
        {
          icon: "browser",
          title: "ブラウザー",
          text: "ページにファイルを置くだけ。Web Worker が読み、何もアップロードしません。",
          link: { text: "ファイルを開く", href: "/ja/open/" },
        },
        {
          icon: "terminal",
          title: "コマンドライン",
          text: "コマンド 1 つで、手元の DuckDB が読んだファイルをブラウザーに開きます。",
          code: "npx vastgrid-cli sales.parquet",
          link: { text: "コマンド", href: "/ja/apps/cli/" },
        },
        {
          icon: "chat",
          title: "AI のチャット",
          text:
            "Claude Desktop・ChatGPT・VS Code・Goose で動く MCP App。エージェントが会話の中にグリッドを開き、" +
            "あなたと同じグリッドを操作します。",
          code: "npx -y vastgrid-mcp ./data",
          link: { text: "MCP サーバー", href: "/ja/apps/mcp/" },
        },
        {
          icon: "notebook",
          title: "Jupyter",
          text:
            "pandas・Polars の DataFrame、DuckDB のリレーション、ファイルをノートブックに表示し、編集した表を" +
            "受け取れます。",
          code: "pip install vastgrid",
          link: { text: "ウィジェット", href: "/ja/apps/notebook/" },
        },
      ],
    },
    features: {
      heading: "表計算ソフトの操作を、すべての行に",
      text: "並べ替え・絞り込み・グループ化・統計は、画面の行ではなく、エンジンが表全体に対して行います。",
      items: [
        {
          icon: "rows",
          title: "どんな大きさでも",
          text:
            "行はスクロールに合わせてブロックごとに読みます。Parquet ファイルはその場で読み、HTTP の Range " +
            "リクエストでも読めます。",
        },
        {
          icon: "canvas",
          title: "キャンバスに描く",
          text:
            "スクロールしても React は描画せず、フレームも落としません。矢印キーでの React のコミットは 1 回です。" +
            "キャンバスの下は ARIA のグリッドです。",
        },
        {
          icon: "sheet",
          title: "表計算ソフトの操作",
          text:
            "Excel のキーと選択、絞り込みと条件、検索、グループ・ピボット・集計、数式、書式、コピー・切り取り・" +
            "貼り付け・フィル。",
        },
        {
          icon: "shield",
          title: "安心して編集できる",
          text:
            "入力は列の型で確かめ、衝突を見つけ、書き込みはすべて元に戻せます。CSV と TSV の保存は、編集した" +
            "フィールドだけを書き直します。",
        },
        {
          icon: "braces",
          title: "API はコマンド",
          text:
            "表示は JSON のドキュメントです。変更はすべて型の付いたコマンドで、グリッドのメニューと同じように、" +
            "自作のツールバー、ホスト、AI のエージェントから送れます。",
        },
        {
          icon: "engine",
          title: "エンジンを選べる",
          text:
            "ページや Web Worker の vastgrid-js、Node.js の vastgrid-duckdb、または自作のもの。1 つの仕様と、" +
            "両方のエンジンが通る適合テストがあります。",
        },
      ],
    },
    code: {
      heading: "数行でグリッドを",
      text:
        "グリッドとエンジンを入れて、表を渡すだけです。同じコンポーネントで、サーバーのファイルを vastgrid-duckdb " +
        "で、人が選んだファイルを Web Worker の中で読むこともできます。",
      links: [
        { text: "使い始める", href: "/ja/getting-started/" },
        { text: "ブラウザーで開く大きなファイル", href: "/ja/guides/browser/" },
        { text: "サーバーのファイル", href: "/ja/guides/server/" },
        { text: "自作のエンジン", href: "/ja/guides/custom-engine/" },
      ],
      tabs: { memory: "メモリで", server: "サーバーで" },
    },
    end: {
      heading: "いちばん大きなファイルを開いてみてください",
      text: "デモの 20 万件の注文を試すか、手元のファイルを開いてください。ファイルはブラウザーの外に出ません。",
      demo: { text: "デモを試す", href: "/ja/demo/" },
      open: { text: "ファイルを開く", href: "/ja/open/" },
      github: { text: "GitHub", href: github },
      note: [
        "vastgrid 0.1 からは",
        { text: "0.1 からの移行", href: "/ja/migrating-from-0-1/" },
        "を参照してください。すべてのリリースは",
        { text: "変更履歴", href: changelog },
        "にあります。",
      ],
    },
  },
};
