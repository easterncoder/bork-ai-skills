'use strict';
/* Copy an environment while removing inherited fixture-incompatible identities. */
function environmentWithout({keys = [], prefixes = []} = {}, source = process.env) {
    return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key) && !prefixes.some(prefix => key.startsWith(prefix))));
}
module.exports = {environmentWithout};
