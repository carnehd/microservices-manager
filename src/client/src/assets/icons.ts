// Ícones da maquete (Figma "Service workspace"), servidos pelo Vite como URLs; usados em <img> com o tamanho nativo do SVG.
const icon = (file: string): string => new URL(`./icons/${file}`, import.meta.url).href

export const icons = {
  search: icon('search.svg'), // 15×15
  sortAz: icon('sort-az.svg'), // 16×16
  gitBranch11: icon('git-branch-11.svg'), // 11×11 (sidebar)
  gitBranch13: icon('git-branch-13.svg'), // 13×13 (cabeçalho do serviço)
  starFavorite: icon('star-filled.svg'), // 13×13, contorno âmbar (favorito)
  starSelected: icon('star-selected.svg'), // 13×13, contorno azul (favorito na linha selecionada)
  chevronRight: icon('chevron-right.svg'), // 12×12
  chevronDown: icon('chevron-down.svg'), // 15×15
  play: icon('play.svg'), // 15×15
  folder: icon('folder.svg'), // 15×15
  pencil: icon('pencil.svg'), // 12×12
  check: icon('check.svg'), // 15×15
  arrowDown: icon('arrow-down.svg') // 15×15
}
