const {
  getPremiereVersion,
  ppro,
  validateNoArgs
} = require("./shared.js");

module.exports = {
  category: "health",
  handlers: [
    {
      name: "ping",
      validate: validateNoArgs,
      async execute() {
        // ppro는 게으른 요구 getter(함수)다 — shared.js 상단 주석 참조.
        const project = await ppro().Project.getActiveProject();
        const activeSequence = project ? await project.getActiveSequence() : null;

        return {
          connected: true,
          premiereVersion: await getPremiereVersion(),
          projectName: project && project.name ? project.name : "No project open",
          activeSequence: activeSequence ? activeSequence.name : "None"
        };
      }
    }
  ]
};
