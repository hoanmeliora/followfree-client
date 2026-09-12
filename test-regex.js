const str = "3 người";
const directMatch = str.match(/([0-9.,]+)\s*(K|M|B)?\s*(cảm xúc|người|lượt|thích|like)/i);
console.log(directMatch);
