/**
 * Get the first event with the given name from the given logs
 * @param {Array<{eventName:string}>} events
 * @param {string} name
 * @returns {*}
 */
function getContractEvent(events, name) {
    return events.find(({eventName}) => eventName === name);
}

module.exports = {
    getContractEvent
}