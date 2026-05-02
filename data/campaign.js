// Donjon : À la Chasse aux Gobs
// Structuré sous forme de Graphe d'État (State Machine) pour l'IA, incluant l'introduction.

export const CAMPAIGN_CONTEXT = {
  title: "À la Chasse aux Gobs",
  setting: "Fial, un village tranquille niché au creux de la grande vallée du Saril, à l'est de la province d'Egonzasthan. Placé sous l'autorité du chevalier de Saint-Bris.",

  /**
   * Heure de départ canonique de la campagne (minutes depuis Jour 1, 00h00).
   * Ex: 13h00 -> 13 * 60 = 780.
   */
  startWorldTimeMinutes: 13 * 60,

  /** Affiché une fois en tête du chat au lancement de la partie (encadré). */
  chatOpeningContext: {
    title: "Contexte",
    body: `Fial est un village tranquille niché au creux de la grande vallée du Saril, à l'est de la province d'Egonzasthan, et placé sous l'autorité du chevalier de Saint-Bris.
    
    Depuis environ deux semaines, plusieurs villageois ont aperçu sur la colline, à l'ouest, des gobelins. Toutefois, jusque-là, aucun raid de ces petites créatures maléfiques n'est à déplorer. Gérald de Flamberge, le régisseur de Saint-Bris, a été prévenu, mais le chevalier a d'autres chats à fouetter pour le moment, en particulier une bande d'orques qui sévit dans les montagnes au sud-est de Fial et qui représente un danger bien plus important. De Flamberge, pour sa part, n'a que deux soldats à ses ordres, et il préfère les garder au village avec lui plutôt que de les envoyer prendre des risques dans la forêt.`,
  },
  backstory: "Depuis 2 semaines, des gobelins ont été aperçus. Le régisseur, Gérald de Flamberge, refuse d'envoyer ses 2 seuls soldats car une bande d'orques menace le sud-est. Ce midi, Thron (forgeron et chef du village) a appris par le commis du meunier que des gobelins ont enlevé sa fille, Lanéa.",
  mainQuest: "Aller vérifier si la jeune fille capturée est bien Lanéa, et la délivrer discrètement des mains des gobelins sans alerter la mère de Lanéa.",
  npcs: {
    "Thron": "Forgeron et chef de Fial. Père inquiet. Il tutoie les joueurs et les appelle 'Mes enfants'.",
    "Lanéa": "Fille de Thron, amie de certains joueurs. Capturée par les gobelins ce matin.",
    "Gérald de Flamberge": "Régisseur de Saint-Bris, il protège le village mais refuse d'agir contre les gobelins.",
    "Commis du meunier": "Le témoin de l'enlèvement. Il peut indiquer le chemin mais refuse d'approcher de la grotte.",
    "Gandelme le Dextre": "Un halfelin (Hobbit) voleur capturé il y a une semaine. Actuellement torturé dans la grotte.",
    "Elric": "Apprenti alchimiste humain, beau parleur, retenu par les gobelins.",
    "Chef Gobelin": "Leader lâche de la tribu."
  },
  globalRules: [
    "Les gobelins ont la vision dans le noir, pas besoin de torches pour eux.",
    "Un gobelours (créature bien plus grande et forte qu'un gobelin) a été aperçu."
  ],

  /**
   * Prose / ambiance globale pour le narrateur (/api/chat), non mécanique.
   * Toujours envoyé si non vide ; une autre campagne peut remplacer tout le fichier avec le même contrat d'export.
   */
  narratorCampaignContext: `
    L'antre des gobelins

    Plafonds. Tous les plafonds sont à environ 3 mètres de haut.

    Lumière. Par défaut les couloirs sont obscurs et les salles éclairées par des torches. Les gobelins possédant la vision dans le noir, ils ne s'embarrassent pas à éclairer les passages, mais la lumière dans les lieux de vie est plus confortable pour eux.

    Le complexe possède deux parties : une grotte naturelle (salles 1 et 2) et un vieux complexe creusé il y a de nombreuses années et que les gobelins ne font qu'occuper temporairement.
  `.trim()
};

// Export direct (utile pour le moteur si besoin d'import ciblé).
export const CAMPAIGN_START_WORLD_TIME_MINUTES = CAMPAIGN_CONTEXT.startWorldTimeMinutes;

export const GOBLIN_CAVE = {
  // --- SCÈNES D'INTRODUCTION ---
  "scene_village": {
    id: "scene_village",
    title: "Le Village de Fial",
    description: "En début d’après-midi, Thron, le forgeron qui fait également office de chef du village, convoque les personnages. 'Mes enfants, vous êtes les jeunes les plus aguerris du village, et certains d’entre vous sont des amis de ma fille Lanéa. Un commis du vieil Erdrios, le meunier, vient de m’apprendre qu’il vient de voir sur la colline un petit groupe de gobelins portant une jeune femme qui ressemblait beaucoup à ma fille. Or justement Lanéa est partie tôt ce matin dans cette direction, et elle n’est pas revenue à l’heure du repas. Je ne vous cache pas ma préoccupation, et si sa mère l’apprend, elle risque de mourir d’inquiétude. Alors en toute franchise, je voudrais vous demander un énorme service : pourriez-vous aller vérifier si c’est bien ma fille que ces monstres ont attrapée et, si vous le pensez possible, en profiter pour la délivrer des mains de ces créatures ? Si j’y vais moi, ma femme va se douter que quelque chose de grave est en train de se passer.'",
    secrets: "Le commis du meunier, qui a suivi de loin les gobelins, pourra indiquer au groupe où se situe l’entrée de leur antre, à environ trois heures de marche à l’ouest, dans les collines, mais il se gardera bien, personnellement, de s’approcher trop près. De plus, si les personnages posent quelques questions aux autres villageois avant de partir, ils apprennent également qu’un gobelours, un monstre bien plus grand et bien plus fort qu’un gobelin, a également été aperçu du même côté il y a quelques jours.",
    exits: [
      {
        id: "scene_journey",
        direction: "ouest",
        description: "En quittant le village vers l'ouest, le chemin devient plus sauvage et monte vers les collines boisées."
      }
    ]
  },
  "scene_journey": {
    id: "scene_journey",
    title: "En chemin vers la colline",
    description: "Les joueurs se mettent en route vers l'ouest. La marche dure environ trois heures dans les collines forestières.",
    secrets: "Si le groupe se met en route immédiatement, les personnages arrivent en vue de l’entrée de la grotte en fin d’après-midi, et ils ont 20% de chance de se faire attaquer par un groupe de deux gobelins en patrouille. Si pour une raison ou une autre ils ne parviennent sur place qu’à la nuit tombée, les chances d’attaque passent alors à 80% et la patrouille est composée de trois gobelins. Chaque gobelin possède 18 pa. Si ils ne se font pas attaquer ils arrivent directement dans la grotte (room_intro).",
    exits: [
      {
        id: "room_intro",
        direction: "ouest",
        description: "La piste débouche face à l'entrée d'une grotte sur le flanc de la colline."
      }
    ]
  },
  // --- LE DONJON ---
  "room_intro": {
    id: "room_intro",
    title: "Entrée de la grotte",
    description: "Après tout ce chemin, vous arrivez enfin en vue de la grotte. L’entrée est bloquée par une grosse porte en bois fermée à clef, avec des montants en fer et une grosse serrure.",
    secrets: "La porte est plutôt solide (Force DD 15 pour l’enfoncer) mais la serrure est particulièrement grossière (Dextérité DD 10 pour l’ouvrir, à condition d’avoir des outils de voleur).",
    exits: [
      {
        id: "room_1",
        direction: "nord",
        description: "Au-delà de la porte verrouillée, l'accès mène à une cavité naturelle plongée dans la pénombre."
      },
      {
        id: "scene_journey",
        direction: "est",
        description: "Le chemin de la colline qui retourne au village"
      }
    ]
  },
  "room_1": {
    id: "room_1",
    title: "L'Entrée",
    description: "Une petite grotte naturelle et obscure (plafond à 3m). Apres l'entre se situe un croisement depuis lequel plusieurs galleries partent dans des directions différentes.",
    secrets: "Deux gobelins sont censés y monter la garde, mais pour le moment… ils somnolent. Ils n'entendront pas si on crochète la serrure et seront surpris (donc n’agiront pas durant le premier round), de même pour une entrée violente et en force dans la pièce. Ils portent une armure de cuir et un cimeterre mais ont peu de chance d’avoir le temps de prendre leur bouclier (baisser leur CA de 2 dans ce cas). L’un possède 12 po, l’autre 16 pc.",
    exits: [
      {
        id: "room_2",
        direction: "ouest",
        description: "Vers l'ouest, un étroit couloir rocheux s'éloigne du carrefour principal."
      },
      {
        id: "room_x",
        direction: "nord",
        description: "Au nord, un long couloir sombre file droit devant."
      },
      {
        id: "room_5",
        direction: "est",
        description: "À l'est, une galerie basse se prolonge dans la pénombre, avec des traces de passages fréquents."
      },
      {
        id: "room_intro",
        direction: "sud",
        description: "Au sud, la sortie de la grotte mène vers l'extérieur."
      }
    ]
  },
  "room_x": {
    id: "room_x",
    title: "Le Couloir piégé",
    description: "Un petit couloir",
    secrets: "Le couloir qui file tout droit est piégé. C’est une fosse simple, un trou creusé dans le sol et recouvert d'une large toile fixée sur les bords de la fosse, le tout camouflé avec de la terre et des débris. Un jet de Sagesse (Perception) DD 10 réussi permet de remarquer la fosse à temps. Dans le cas contraire, le premier personnage qui marche dessus tombe dans le trou profond de 3 mètres et subit 1d6 points de dégâts contondants. Au fond du couloir un il y a un tournant a gauche (ouest), mais il ne mene nulle part, c'est un cul de sac. ",
    exits: [
      {
        id: "room_1",
        direction: "sud",
        description: "Au sud, le couloir retourne vers la première grande caverne de l'entrée."
      }
    ]
  },
  "room_2": {
    id: "room_2",
    title: "La Salle d'armes",
    description: "Cette grotte semble servir de râtelier. On y trouve adossées le long de la paroi un certain nombre d'armes qui ne sont pas d'une facture exceptionnelle : 1 fronde et 20 pierres, 4 javelines, 2 marteaux de guerre, 1 épée longue, 1 arbalète lourde et 10 carreaux, 3 morgensterns, ainsi qu’une cuirasse de taille humaine, une cotte de mailles de la taille d’un nain et 8 boucliers en bois. À droite, en contre bas, on observe une porte en bois fermée.",
    secrets: "Il n’y a pas de lumière dans cette salle qui est peu utilisée.",
    exits: [
      {
        id: "room_3",
        direction: "nord",
        description: "Au nord, le passage monte vers une porte en bois."
      },
      {
        id: "room_1",
        direction: "est",
        description: "À l'est, le boyau rocheux ramène au carrefour principal de l'entrée."
      }
    ]
  },
  "room_3": {
    id: "room_3",
    title: "L'Entrepôt",
    description: "L’intérieur de cette salle comporte des rouleaux de tissus, des poteries, une selle de cheval, des outils de paysans, mais rien de grande valeur. Sur chacun des quatre piliers en bois est accrochée une torche, mais aucune n’est allumée.",
    secrets: "La porte dans cette salle est fermée à clef (celle connectant la salle 2 au sud), mais là encore la serrure est des plus sommaires. Réussir un jet de Dextérité DD 10 si le personnage possède des outils de voleur est suffisant pour la crocheter. Cette salle sert en fait à entasser le résultat des différents vols effectués par la tribu.",
    exits: [
      {
        id: "room_4",
        direction: "ouest",
        description: "À l'ouest, une porte donne accès à une autre petite pièce sombre."
      },
      {
        id: "room_2",
        direction: "sud",
        description: "Au sud, une porte."
      }
    ]
  },
  "room_4": {
    id: "room_4",
    title: "La Salle de Torture",
    description: "Il y a ici un grand nombre d'instruments de torture et notamment un chevalet sur lequel a pris place un personnage que certains d’entre vous connaissent, le halfelin Gandelme le Dextre, qui était venu rendre visite à Fial à son frère Petit-Pinpin la semaine dernière ! D’après les marques qu’ils portent, le petit homme a visiblement été torturé.",
    secrets: "Ici aussi, des torches sont accrochées aux murs, mais aucune n’est allumée. Gandelme est épuisé, affamé et déshydraté. On ne lui a rien donné à boire ni à manger depuis sa capture. Il est si faible (0 pv et épuisement niveau 4) qu’il ne peut pas marcher et encore moins combattre. Un sort de soins lui redonnera des points de vie et lui permettra de marcher, mais ne réduira pas ses niveaux d’épuisement. Il insistera pour que l’on retrouve son équipement. Celui-ci se trouve dans la chambre du chef, salle 17, mais il ne le sait pas, bien entendu.",
    exits: [
      {
        id: "room_3",
        direction: "est",
        description: "La seule issue est la porte à l'est, qui ramène dans l'entrepôt."
      }
    ]
  },
  "room_5": {
    id: "room_5",
    title: "La Réserve de nourriture",
    description: "La double porte donne sur vaste pièce sans lumière qui est en grande partie vide. Dans la partie sud on trouve toutefois un monceau de nourriture : viandes, fruits séchés, alcools, légumes.",
    secrets: "De quoi nourrir de nombreux gobelins durant des jours.",
    exits: [
      {
        id: "room_6",
        direction: "est",
        description: "A l'est, une large ouverture mène vers une zone dégageant une forte odeur de cuisson."
      },
      {
        id: "room_1",
        direction: "ouest",
        description: "À l'ouest, le passage retourne vers le carrefour de l'entrée."
      }
    ]
  },
  "room_6": {
    id: "room_6",
    title: "La Cuisine",
    description: "Deux torches aux murs illuminent cette pièce qui ne contient pas grand-chose non plus. Juste un fourneau avec un feu allumé dont la fumée s’échappe par un trou au plafond, des plats et des casseroles sales, et un peu de nourriture qui ne fait pas du tout envie.",
    secrets: "Rien de special",
    exits: [
      {
        id: "room_5",
        direction: "ouest",
        description: "L'unique sortie est l'ouverture a l'ouest, redescendant vers la réserve de nourriture."
      },
      {
        id: "room_9",
        direction: "nord",
        description: "Un petit couloir amène à une porte"
      }
    ]
  },
  "room_9": {
    id: "room_9",
    title: "La Salle Commune",
    description: "La salle contient deux grandes tables et plusieurs bancs. Actuellement deux créatures de la taille d’un humain mais avec des traits semblables à ceux des gobelins sont en train de manger.",
    secrets: "Si les personnages prennent le temps d’écouter avant de rentrer dans la pièce, ils entendront clairement deux créatures parler entre elles en gobelins. Des Hobgobelins sont occupés à manger et pensant que tout bruit normal vient surement des gobelins de l’antre, les deux hobgobelins ne sont normalement pas sur leur garde. Les hobgobelins ont leur épée longue sur eux et feront leur possible pour récupérer rapidement leur bouclier qui sont posés sur la table. Fiers guerriers, ils essayeront de se débarrasser des intrus tous seuls, mais si l’un d’eux vient à mourir, le survivant n’hésitera pas à crier pour alerter les gobelins de la salle 7 et de la salle 10.",
    exits: [
      {
        id: "room_10",
        direction: "nord",
        description: "Sur la gauche du mur nord, un passage rejoint une intersection de couloirs."
      },
      {
        id: "room_7",
        direction: "ouest",
        description: "Dans le mur, une autre porte se trouve au bout d'un court couloir."
      },
      {
        id: "room_6",
        direction: "sud",
        description: "Une porte simple qui donne accès à la cuisine."
      }
    ]
  },
  "room_7": {
    id: "room_7",
    title: "Chambre de Gobelins (Dés)",
    description: "À l'intérieur de cette pièce se trouvent deux gobelins en train de jouer aux dés sur une table ronde en bois. Il y a aussi six paillasses de petite taille et un coffre fermé à clef.",
    secrets: "Les gobelins seront normalement surpris. Comme leurs congénères de l’entrée, il y a peu de chance qu’ils aient le temps de prendre leur bouclier (baisser leur CA de 2 dans ce cas). Un des gobelins porte sur lui la clef du coffre qui contient 252 pc.",
    exits: [
      {
        id: "room_8",
        direction: "nord",
        description: "Un petit passage relie cette pièce à une autre chambre."
      },
      {
        id: "room_9",
        direction: "est",
        description: "Une porte."
      }
    ]
  },
  "room_8": {
    id: "room_8",
    title: "La Chambre des Hobgobelins",
    description: "Dans cette pièce se trouvent deux paillasses de taille humaine et une grosse bourse.",
    secrets: "C’est bien entendu là que dorment les deux hobgobelins, mais pour le moment ils sont en train de manger dans la salle commune. La bourse contient 11 po et 1 pp.",
    exits: [
      {
        id: "intersection_1",
        direction: "nord",
        description: "Une porte ouverte donne sur une intersection de couloirs."
      },
      {
        id: "room_7",
        direction: "sud",
        description: "Une porte"
      }
    ]
  },
  "room_10": {
    id: "room_10",
    title: "Chambre de Gobelins",
    description: "Il y a dans cette pièce six paillasses et deux gobelins y sont allongés, en train de dormir.",
    secrets: "Ces gobelins ont le sommeil profond et un simple combat dans la salle 9 ne devrait pas les réveiller. Mais en cas de cris d’un hobgobelin, ils accourront voir ce qu’il se passe.",
    exits: [
      {
        id: "room_9",
        direction: "sud",
        description: "La seule issue est la porte au sud, qui retourne dans la salle commune."
      },
      {
        id: "intersection_1",
        direction: "ouest",
        description: "Une porte."
      }
    ]
  },
  "intersection_1": {
    id: "intersection_1",
    title: "Intersection est du grand couloir",
    description: "Un couloir horizontal reliant l'ouest à l'est. Les murs sont bruts et les sons résonnent facilement ici.",
    secrets: "",
    exits: [
      {
        id: "intersection_2",
        direction: "ouest",
        description: "Le long couloir continue sur quelques metres avant d'arriver a une autre intersection."
      },
      {
        id: "room_10",
        direction: "est",
        description: "Le couloir se termine sur une porte usée"
      },
      {
        id: "room_8",
        direction: "sud",
        description: "Un petit passage mene a une porte."
      }
    ]
  },
  "intersection_2": {
    id: "intersection_2",
    title: "Intersection ouest du grand couloir",
    description: "Un couloir horizontal relie l'ouest à l'est. Les murs sont bruts et les sons résonnent facilement ici.",
    secrets: "",
    exits: [
      {
        id: "room_11",
        direction: "ouest",
        description: "Le couloir se termine sur une porte sombre."
      },
      {
        id: "intersection_1",
        direction: "est",
        description: "Le long couloir s'étend sur quelques metres avant d'arriver a une autre intersection."
      },
      {
        id: "room_13",
        direction: "nord",
        description: "Un passage monte vers une porte fermée."
      }
    ]
  },
  "room_11": {
    id: "room_11",
    title: "La Chambre du Gobelours",
    description: "",
    secrets: "Lorsqu’ils ouvrent la porte de cette pièce, les personnages aperçoivent une créature qui correspond à la description qu’on leur a peut-être fait à Fial d’un gobelours. Le monstre est de profil et en train de cacher un petit sac sous sa paillasse. Il ne possède comme arme qu’une Morgenstern, n’a pas de bouclier (baisser sa CA de 2). Le petit sac qu’il tentait de cacher contient 40 po. Le gobelours n’appréciera certainement pas qu’on entre chez lui comme cela sans demander la permission, et encore moins alors qu’il était en train de ranger le butin de sa dernière sortie. Il attaquera donc, sans hésiter.",
    exits: [
      {
        id: "room_12",
        direction: "ouest",
        description: "Un mur de pierre brut à l'ouest."
      },
      {
        id: "intersection_2",
        direction: "est",
        description: "À l'est, la porte donne sur une intersection de couloirs."
      }
    ]
  },
  "room_12": {
    id: "room_12",
    title: "La Salle du Trésor (Secrète)",
    description: "",
    secrets: "Protégée par un passage secret (Investigation DD 15), on peut y trouver six petites statuettes en ivoire (valeur de 60 po au total), deux potions de soins (qui font regagner 2d4+2 pv) et un grand coffre non fermé à clef qui contient 2000 pc, 1000 pa et 70 po. Il n’y a aucune lumière ici.",
    exits: [
      {
        id: "room_11",
        direction: "est",
        description: "Le passage secret dissimulé à l'est permet de retourner dans la chambre du Gobelours."
      }
    ]
  },
  "room_13": {
    id: "room_13",
    title: "La Salle du Trône",
    description: "Au fond de cette vaste salle, la plus grande du complexe jusque-là, se trouve un trône en bois sur lequel est assis celui qui doit assurément être le chef de cette petite tribu de gobelins. Trois autres gobelins sont présents. Deux grands tapis recouvrent des pans de mur.",
    secrets: "Les trois gobelins attaqueront dès que le groupe entrera. Par contre le chef, à traiter comme un gobelin normal, est un poltron qui fera tout pour ne pas combattre. Dès qu'il verra que le combat tourne mal, il essayera de s'enfuir par le passage secret derrière son trône (qui est collé au mur arrière), qui s’active en faisant tourner ce dernier (Investigation DD 15 par défaut, ou DD 5 si un personnage a vu le chef l’activer). Le passage secret se referme derrriere le chef gobelin s'il l'emprunte. Chaque gobelin porte 24 pa sur lui.",
    exits: [
      {
        id: "room_14",
        direction: "est",
        description: "À l'est, une solide porte fermée mène à une autre aile du donjon."
      },
      {
        id: "room_16",
        direction: "nord-ouest",
        description: "Au nord-ouest, une petite porte lourde semble donner sur une geôle."
      },
      {
        id: "room_17",
        direction: "nord-est",
        description: "Au nord-est, une autre porte s'ouvre vers une petite pièce annexe."
      },
      {
        id: "room_9",
        direction: "sud",
        description: "Au sud, le couloir d'accès redescend vers le reste du complexe gobelin."
      }
    ],
    secretExits: [
      {
        id: "room_secret_chief_tunnel",
        targetRoomId: "room_secret_chief_tunnel",
        descriptionWhenDiscovered: "Derrière le trône, un passage secret ouvert s'enfonce dans l'obscurité.",
        discoveryKey: "room_13_secret_passage_revealed"
      }
    ]
  },
  "room_secret_chief_tunnel": {
    id: "c",
    title: "Le Passage Secret du Chef",
    description: "Le passage secret s'etend sur 10 mètres dans une cavité souterraine ronde mais ne mene nulle part.",
    secrets: "Un petit coffre et des vivres sont cachés dans l'obscurité. ",
    exits: [
      {
        id: "room_13",
        direction: "sud",
        description: "Au sud, le passage retourne vers la salle du trône."
      }
    ]
  },
  "room_14": {
    id: "room_14",
    title: "Le Laboratoire",
    description: "Dans cette pièce se trouvent nombre d'étagères contenant plein de pots et de fioles sans étiquette, et tout un tas de matériel qui semble être celui d’un alchimiste.",
    secrets: "Cette pièce est fermée à clef (Dextérité DD 15 pour la crocheter, à condition d’avoir des outils de voleur, ou Force DD 15 pour l’enfoncer). Les pots, les fioles et le materiel dans son ensemble sont les ingrédients de l’apprenti alchimiste de la salle 15, mais même un magicien n’y reconnaîtra rien !",
    exits: [
      {
        id: "room_15",
        direction: "est",
        description: "À l'est, une simple porte mène aux quartiers attenants."
      },
      {
        id: "room_13",
        direction: "ouest",
        description: "À l'ouest, la porte retourne vers la salle du trône."
      }
    ]
  },
  "room_15": {
    id: "room_15",
    title: "La Chambre de l'Alchimiste",
    description: "Cette pièce possède un bureau de belle facture, une chaise, un tapis épais au sol, et un lit. Elle sent nettement meilleure que toutes les autres pièces visitées.",
    secrets: "Elric, le jeune apprenti alchimiste humain qui vit ici, est le seul à vivre de jour et à dormir de nuit. Suivant l’heure à laquelle les personnages arrivent, il dort ou bien est en train de travailler sur son grimoire, assis à son bureau. Elric se rend rapidement compte que, seul, il ne fera pas le poids face aux personnages. Il essayera donc de les endormir par de belles paroles, prétendant en premier lieu être prisonnier des gobelins, puis suppliant le membre du groupe qui semble le plus clément de le laisser partir. En fait, il tentera de s'enfuir dès qu’il en aura l’occasion. Ni Gandelme ni Lanéa ne l’avaient vu avant, et il n’a participé à aucun raid avec les gobelins. Il n’a en fait que peu de relations avec les gobelins. Renvoyé par son mentor pour incapacité, il cherchait un endroit tranquille pour réaliser ses expériences, et a été attaqué par les gobelins. Mais, parlant leur langue, et plutôt doué pour embobiner les autres, il a réussi à convaincre leur chef qu’il pouvait transformer le fer en or. Il est donc confiné ici jusqu’à ce qu’il parvienne à montrer les preuves de son soi-disant talent. Il n’est pas autorisé à sortir de l’antre, mais les gobelins le nourrissent, ce qui lui permet de se consacrer de plein temps à ses expériences… infructueuses jusque-là. Il n’a rien de valeur sur lui, mis à part la clef de la salle 14 et son grimoire qui contient tous les sorts qu’il a préparés (voir sa fiche de stat) plus un autre sort de niveau 1 (à déterminer au hasard).",
    exits: [
      {
        id: "room_14",
        direction: "ouest",
        description: "L'unique sortie est la porte à l'ouest, retournant dans le laboratoire."
      }
    ]
  },
  "room_16": {
    id: "room_16",
    title: "La Cellule",
    description: "Cette pièce qui baigne dans l’obscurité est une cellule. Ceux d’entre vous qui connaissent Lanéa, la fille du chef, la reconnaissent tout de suite, pieds et poings liés par une corde. Elle ne semble toutefois pas avoir été maltraitée et vous reconnaît immédiatement.",
    secrets: "Si le groupe n’a pas encore trouvé Gandelme dans la salle 4, Lanéa leur révèle qu’elle l’a aperçu la veille et qu’il faut absolument le trouver avant de partir d’ici.",
    exits: [
      {
        id: "room_13",
        direction: "sud",
        description: "La porte au sud permet de retourner dans la salle du trône."
      }
    ]
  },
  "room_17": {
    id: "room_17",
    title: "La Chambre du Chef",
    description: "Cette chambre bien décorée contient un vrai lit, des tapis par terre et sur les murs, et un sac à dos sur lequel est posé un bouclier et une épée courte de petite taille. Les deux torches au mur sont éteintes.",
    secrets: "Le bouclier et l’épée courte appartiennent au halfelin Gandelme, capturé par les gobelins il y a une semaine, de même que le sac à dos qui, en plus de l’équipement standard de tout aventurier (sac d’explorateur), contient des outils de voleur et 20 po.",
    exits: [
      {
        id: "room_13",
        direction: "sud",
        description: "La porte au sud mène directement à la salle du trône."
      }
    ]
  }
};

function normalizeSecretExitText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function roomMemoryRevealsSecretExit(secretExit, roomMemoryText) {
  const memory = normalizeSecretExitText(roomMemoryText);
  if (!memory) return false;

  const discoveryKey = normalizeSecretExitText(secretExit?.discoveryKey);
  if (discoveryKey && memory.includes(discoveryKey)) return true;

  const discoveredDescription = normalizeSecretExitText(secretExit?.descriptionWhenDiscovered);
  if (discoveredDescription && memory.includes(discoveredDescription)) return true;
  return false;
}

export function getVisibleExitsForRoom(roomId, roomMemoryText = "") {
  const room = roomId && GOBLIN_CAVE?.[roomId] ? GOBLIN_CAVE[roomId] : null;
  if (!room) return [];

  const visibleExits = Array.isArray(room.exits)
    ? room.exits
        .map((exitDef) => {
          if (typeof exitDef === "string" && exitDef.trim()) {
            return { id: exitDef.trim(), direction: "", description: "" };
          }
          if (!exitDef || typeof exitDef !== "object") return null;
          const targetId = String(exitDef.id ?? "").trim();
          if (!targetId) return null;
          return {
            ...exitDef,
            id: targetId,
            direction: String(exitDef.direction ?? "").trim(),
            description: String(exitDef.description ?? "").trim(),
          };
        })
        .filter(Boolean)
    : [];

  const discoveredSecretExits = Array.isArray(room.secretExits)
    ? room.secretExits
        .filter((secretExit) => roomMemoryRevealsSecretExit(secretExit, roomMemoryText))
        .map((secretExit) => {
          const targetRoomId = String(secretExit?.targetRoomId ?? "").trim();
          if (!targetRoomId) return null;
          return {
            id: targetRoomId,
            direction: String(secretExit?.direction ?? "").trim(),
            description: String(secretExit?.descriptionWhenDiscovered ?? "").trim(),
            isSecret: true,
            secretSourceId: String(secretExit?.id ?? "").trim() || null,
          };
        })
        .filter(Boolean)
    : [];

  return [...visibleExits, ...discoveredSecretExits];
}