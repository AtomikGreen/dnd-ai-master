// Donjon : À la Chasse aux Gobs
// Structuré sous forme de Graphe d'État (State Machine) pour l'IA, incluant l'introduction.

export const CAMPAIGN_CONTEXT = {
  title: "À la Chasse aux Gobs",
  setting: "Fial, un village tranquille niché au creux de la grande vallée du Saril, à l'est de la province d'Egonzasthan. Placé sous l'autorité du chevalier de Saint-Bris.",

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

export const GOBLIN_CAVE = {
  // --- SCÈNES D'INTRODUCTION ---
  "scene_village": {
    id: "scene_village",
    title: "Le Village de Fial - La Forge de Thron",
    description: "En début d'après-midi, les joueurs sont convoqués en secret à la forge par Thron, le chef du village. Il a l'air très inquiet. Il doit prononcer ce discours : 'Mes enfants, vous êtes les jeunes les plus aguerris du village. Le commis du meunier vient de voir sur la colline à l'ouest des gobelins portant une jeune femme ressemblant à ma fille Lanéa... Je vous demande de la sauver discrètement, si ma femme l'apprend, elle mourra d'inquiétude.'",
    secrets: "Si les joueurs posent des questions : 1. Ils apprennent qu'un gobelours a été aperçu récemment. 2. L'antre est à environ 3 heures de marche à l'ouest. Le commis du meunier peut montrer la direction mais n'ira pas plus loin.",
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
    secrets: "Si le groupe se met en route immédiatement, les personnages arrivent en vue de l’entrée de la grotte en fin d’après-midi, et ils ont 20% de chance de se faire attaquer à quelques encablures de l’antre par un groupe de deux gobelins en patrouille. Si pour une raison ou une autre ils ne parviennent sur place qu’à la nuit tombée, les chances d’attaque passent alors à 80% et la patrouille est composée de trois gobelins. Chaque gobelin possède 18 pa.",
    exits: [
      {
        id: "room_intro",
        direction: "ouest",
        description: "Après plusieurs heures de marche, la piste débouche face à l'entrée d'une grotte sur le flanc de la colline."
      }
    ]
  },
  // --- LE DONJON ---
  "room_intro": {
    id: "room_intro",
    title: "Chemin vers la grotte",
    description: "Après tout ce chemin, vous arrivez enfin en vue de la grotte. L’entrée est bloquée par une grosse porte en bois fermée à clef, avec des montants en fer et une grosse serrure.",
    secrets: "La porte est plutôt solide (Force DD 15 pour l’enfoncer) mais la serrure est particulièrement grossière (Dextérité DD 10 pour l’ouvrir, à condition d’avoir des outils de voleur).",
    exits: [
      {
        id: "room_1",
        direction: "nord",
        description: "Au-delà de la porte verrouillée, l'accès mène à une cavité naturelle plongée dans la pénombre."
      }
    ]
  },
  "room_1": {
    id: "room_1",
    title: "L'Entrée",
    description: "Une petite grotte naturelle et obscure (plafond à 3m).",
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
    secrets: "Le couloir qui file tout droit est piégé (emplacement marqué X). C’est une fosse simple, un trou creusé dans le sol et recouvert d'une large toile fixée sur les bords de la fosse, le tout camouflé avec de la terre et des débris. Un jet de Sagesse (Perception) DD 10 réussi permet de remarquer la fosse à temps. Dans le cas contraire, le premier personnage qui marche dessus tombe dans le trou profond de 3 mètres et subit 1d6 points de dégâts contondants.",
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
    description: "Cette grotte semble servir de râtelier. On y trouve adossées le long de la paroi un certain nombre d'armes qui ne sont pas d'une facture exceptionnelle : 1 fronde et 20 pierres, 4 javelines, 2 marteaux de guerre, 1 épée longue, 1 arbalète lourde et 10 carreaux, 3 morgensterns, ainsi qu’une cuirasse de taille humaine, une cotte de mailles de la taille d’un nain et 8 boucliers en bois. À droite, en contre bas, on observe une porte en bois entrouverte.",
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
    description: "La porte est fermée à clef. À l'intérieur, des rouleaux de tissus, poteries, outils de paysans. Quatre piliers en bois portent des torches éteintes.",
    secrets: "Serrure : Dextérité DD 10 pour crocheter. C'est le butin des vols au village.",
    exits: [
      {
        id: "room_4",
        direction: "ouest",
        description: "À l'ouest, une porte donne accès à une autre petite pièce sombre."
      },
      {
        id: "room_2",
        direction: "sud",
        description: "Au sud, la porte s'ouvre sur des marches descendant vers la salle d'armes."
      }
    ]
  },
  "room_4": {
    id: "room_4",
    title: "La Salle de Torture",
    description: "Torches éteintes. Beaucoup d'instruments de torture. Sur un chevalet est attaché un halfelin mal en point : Gandelme le Dextre.",
    secrets: "Gandelme a 0 PV et 4 niveaux d'épuisement. Il ne peut ni marcher ni combattre sans soins magiques. Si soigné, il demande aux joueurs de retrouver son équipement (qui est dans la salle 17, mais il ne le sait pas).",
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
    description: "Vaste pièce sombre. Au sud, un monceau de nourriture volée (viande, alcools, fruits).",
    secrets: "Rien de particulier, mais cela montre la capacité de la tribu à tenir un siège.",
    exits: [
      {
        id: "room_6",
        direction: "est",
        description: "Au nord, une large ouverture mène vers une zone dégageant une forte odeur de cuisson."
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
    description: "Deux torches illuminent la pièce. Un fourneau fume, des plats sales et de la nourriture peu ragoûtante traînent.",
    secrets: "Aucun monstre. Lieu de vie crasseux.",
    exits: [
      {
        id: "room_5",
        direction: "ouest",
        description: "L'unique sortie est l'ouverture au sud, redescendant vers la réserve de nourriture."
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
    description: "Deux grandes tables, des bancs. Deux grands Hobgobelins sont en train de manger bruyamment.",
    secrets: "Les hobgobelins n'ont pas leur bouclier en main. Si l'un meurt, l'autre crie pour alerter les gobelins des salles 7 et 10. Combat difficile !",
    exits: [
      {
        id: "room_10",
        direction: "nord",
        description: "Au nord, une simple porte mène à ce qui ressemble à un dortoir."
      },
      {
        id: "room_7",
        direction: "sud-ouest",
        description: "Dans le mur ouest, une autre porte donne accès à des chambrées."
      },
      {
        id: "room_6",
        direction: "",
        description: ""
      }
    ]
  },
  "room_7": {
    id: "room_7",
    title: "Chambre de Gobelins (Dés)",
    description: "Deux gobelins jouent aux dés sur une table ronde. Il y a six petites paillasses et un coffre fermé.",
    secrets: "S'ils n'ont pas entendu de bruit, les gobelins sont surpris. Un gobelin a la clef du coffre (contient 252 pc).",
    exits: [
      {
        id: "room_8",
        direction: "nord",
        description: "Un petit passage relie cette pièce à une autre chambre."
      },
      {
        id: "room_9",
        direction: "est",
        description: "À l'est, une porte s'ouvre directement sur une grande salle bruyante."
      }
    ]
  },
  "room_8": {
    id: "room_8",
    title: "La Chambre des Hobgobelins",
    description: "Deux paillasses de taille humaine.",
    secrets: "Une grosse bourse est cachée ici : 11 po et 1 pp. Les propriétaires sont dans la salle 9.",
    exits: [
      {
        id: "room_9",
        direction: "est",
        description: "À l'est, une porte donne sur la vaste salle commune."
      },
      {
        id: "room_7",
        direction: "sud",
        description: "Au sud, le passage mène à la chambre des gobelins joueurs de dés."
      }
    ]
  },
  "room_10": {
    id: "room_10",
    title: "Chambre de Gobelins (Sommeil)",
    description: "Six paillasses. Deux gobelins dorment profondément.",
    secrets: "Ils ne se réveillent que si les hobgobelins de la salle 9 crient.",
    exits: [
      {
        id: "room_9",
        direction: "sud",
        description: "La seule issue est la porte au sud, qui retourne dans la salle commune."
      }
    ]
  },
  "room_11": {
    id: "room_11",
    title: "La Chambre du Gobelours",
    description: "Un immense Gobelours (Bugbear) est surpris en train de cacher un sac sous son lit.",
    secrets: "Le monstre attaque immédiatement, furieux d'être dérangé. Il a une Morgenstern (pas de bouclier). Son sac contient 40 po. Un passage secret existe vers la salle 12 (Investigation DD 15).",
    exits: [
      {
        id: "room_12",
        direction: "ouest",
        description: "Un mur de pierre brut à l'ouest (si le passage secret est découvert, il pivote)."
      },
      {
        id: "room_9",
        direction: "est",
        description: "À l'est, le couloir ramène vers la zone de la salle commune."
      }
    ]
  },
  "room_12": {
    id: "room_12",
    title: "La Salle du Trésor (Secrète)",
    description: "Une pièce secrète plongée dans l'obscurité totale.",
    secrets: "Le grand coffre n'est pas fermé ! Il contient : 6 statuettes en ivoire (60 po), 2 potions de soins (2d4+2 PV), 2000 pc, 1000 pa, 70 po.",
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
    description: "La plus grande salle. Un grand trône en bois, de grands tapis au mur. Trois gobelins gardent leur chef.",
    secrets: "Les 3 gobelins attaquent. Le chef est un poltron ! S'il perd, il fuit via un passage secret derrière son trône (activé en tournant le trône). Le joueur doit faire Investigation DD 15 pour le trouver, ou DD 5 s'il a vu le chef s'enfuir.",
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
    ]
  },
  "room_14": {
    id: "room_14",
    title: "Le Laboratoire",
    description: "Pièce fermée à clef (DEX DD 15 avec outils, ou FOR DD 15 pour casser). Étagères, pots, fioles, matériel d'alchimiste.",
    secrets: "Rien de dangereux, mais rien d'utile non plus pour un non-initié.",
    exits: [
      {
        id: "room_15",
        direction: "est",
        description: "À l'est, une simple porte mène aux quartiers attenants."
      },
      {
        id: "room_13",
        direction: "ouest",
        description: "À l'ouest, la porte verrouillée retourne vers la salle du trône."
      }
    ]
  },
  "room_15": {
    id: "room_15",
    title: "La Chambre de l'Alchimiste",
    description: "Un beau bureau, un tapis épais, un lit. Un jeune humain, Elric (apprenti alchimiste), est ici.",
    secrets: "Elric est un beau parleur et un escroc. Il prétend être prisonnier et supplie qu'on le laisse partir, mais il tentera de s'enfuir ou de trahir les joueurs. Il a la clef de la salle 14 et un grimoire de magie.",
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
    description: "Pièce sombre. Une jeune femme est attachée pieds et poings liés : c'est Lanéa, la fille du chef du village !",
    secrets: "Elle n'est pas blessée. Si on la libère, elle informe les joueurs que le halfelin Gandelme est aussi prisonnier quelque part (Salle 4).",
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
    description: "Chambre bien décorée, vrai lit, tapis. Un sac à dos, un bouclier de petite taille et une épée courte sont posés au sol.",
    secrets: "Ce sont les affaires volées au halfelin Gandelme (Salle 4). Le sac contient des outils de voleur et 20 po.",
    exits: [
      {
        id: "room_13",
        direction: "sud",
        description: "La porte au sud mène directement à la salle du trône."
      }
    ]
  }
};