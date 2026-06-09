// actions.js
// Node barrel — re-exports the split resolution modules (resolve / block / move
// / pass / kickoff / special) so server.js can keep requiring './actions.js'.
// The browser loads the sub-files directly via <script> tags (see index.html).

if (typeof module !== 'undefined') {
    module.exports = Object.assign({},
        require('./resolve.js'), require('./block.js'), require('./move.js'),
        require('./pass.js'), require('./kickoff.js'), require('./special.js'));
}
