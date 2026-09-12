const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, 'electron/services/auto-reg.service.ts');
let code = fs.readFileSync(p, 'utf8');

// There is a missing closing brace for the `if` block around line 542.
// The code looks like this:
// 539:                             // Đánh dấu đã chạy hàm dropdown fallback xong (dù thành công hay không, chỉ chạy 1 lần tránh lặp vô hạn)
// 540:                             (this as any).hasFilledCombos = true;
// 541:                         }
// 542: 
// 543:                     } catch (e) {
// 544:                         this.log('[Auto-Reg] Lỗi khi điền combobox: ' + e);
// 545:                     }
// We need to add one more closing brace at line 542 to close `if (!(this as any).hasFilledCombos) {`

code = code.replace(
    '(this as any).hasFilledCombos = true;\n                        }\n\n                    } catch (e) {',
    '(this as any).hasFilledCombos = true;\n                        }\n                        }\n\n                    } catch (e) {'
);

fs.writeFileSync(p, code);
console.log('Fixed syntax error!');
